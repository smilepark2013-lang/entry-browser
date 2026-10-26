// tools/simulate.mjs — 생성된 블록 JSON 을 그대로 실행해보는 미니 인터프리터
//
// 왜 필요한가
//   이 환경의 실패는 대부분 예외가 아니라 **침묵**이다. 파라미터 하나를 잘못 꽂아도
//   엔트리는 조용히 다른 값을 쓰거나 아무 일도 안 한다. 빌드 검증(tools/build.mjs)은
//   "자리가 비었는지"만 보고, 그 자리에 **맞는 것**이 들어갔는지는 못 본다.
//   → 실제로 돌려보고 결과를 파이썬 기준 구현과 대조한다.
//
// 엔트리 실제 구현을 따라야 하는 부분 (docs/BLOCKS.md)
//   index_of_string  s.indexOf(t) + 1   — 1-based, 못 찾으면 0
//   char_at          범위 밖이면 예외
//   substring        양 끝 모두 범위 안이어야 함
//   리스트 인덱스     1-based
//
// 시간(프레임 스로틀)은 흉내내지 않는다. 여기서 보려는 건 **의미**지 성능이 아니다.

export class Sim {
    constructor(project) {
        this.p = project;
        this.vars = new Map();      // id -> {name, value, isList, array}
        for (const v of project.variables) {
            this.vars.set(v.id, {
                name: v.name,
                isList: v.variableType === 'list',
                value: v.value,
                array: (v.array || []).map((a) => a.data),
            });
        }
        this.msg = new Map(project.messages.map((m) => [m.name, m.id]));

        this.funcs = new Map();     // `func_${id}` -> body
        for (const f of project.functions) {
            const create = JSON.parse(f.content)[0][0];
            this.funcs.set(`func_${f.id}`, create.statements[0]);
        }

        this.log = { text: [], sound: [], signal: [], out: [], pen: [], ai: [] };
        this.pen = { color: null, size: 1, down: false, x: 0, y: 0 };

        // 오브젝트별 상태. entry-ppt 는 화면의 절반이 글상자라 "누가 무엇을 어디에"
        // 까지 봐야 렌더러를 검사할 수 있다. self 는 지금 도는 스레드의 주인이다.
        this.self = null;
        this.wrote = new Map();     // 오브젝트 -> 마지막으로 쓴 글
        this.fg = new Map();        // 오브젝트 -> 글자색
        this.bg = new Map();        // 오브젝트 -> 배경색
        this.pos = new Map();       // 오브젝트 -> [x, y]
        this.shape = new Map();     // 오브젝트 -> 마지막으로 고른 모양 (그림 풀)
        this.scale = new Map();     // 오브젝트 -> 크기 %
        this.shown = new Map();     // 오브젝트 -> 보이는가
        this.effect = new Map();    // 오브젝트 -> 켜져 있는 글상자 효과 Set
        this.face = new Map();      // 오브젝트 -> 글꼴 이름
        // 복제본 (Entry Browser 레이아웃 모드). 엔트리는 복제하는 순간의 상태(글·색·자리·보이기·효과)를
        // 그대로 복사한다 — 그래서 원본이 자기 상태를 맞추고 복제하는 것만으로 찍어 낼 수 있다.
        this.clones = [];           // [{of, wrote, fg, bg, pos, shown, effect}]

        // 신호를 **실제로 배달할지** 정하는 훅. 기본은 null 이라 예전처럼 기록만 한다.
        //
        // 왜 기본이 기록만인가 — 엔트리에서 신호는 스레드를 새로 시작시키는 것이지
        // 함수 호출이 아니다. 동기로 부르면 순서·재진입이 실제와 달라져서, 그 위에서
        // 통과한 테스트가 실기를 보장하지 못한다. 그래서 테스트가 `runSignal` 로
        // 직접 부르는 방식을 정본으로 둔다.
        //
        // 다만 **기다리는 쪽**은 그렇게 검사할 수 없다. 셸 스크립트 러너는
        // `sh_busy` 가 0 이 되기를 기다리는데(src/script.mjs), 신호가 배달되지 않으면
        // 아무도 0 으로 만들지 않아 영원히 돈다. 그런 모듈만 이 훅을 켠다.
        //   sim.autoSignal = (name) => { ... 필요한 것만 runSignal ... }
        this.autoSignal = null;
        // 🔴 **반복 블록은 한 바퀴가 1프레임이다** (60fps).
        //   그래서 반복 횟수를 세면 그대로 "몇 프레임 걸리는가" 가 된다.
        //   재귀는 같은 프레임 안에서 끝나므로 세지 않는다.
        //   이 숫자가 곧 체감 끊김이다 — tools/test_perf.mjs 가 이걸로 잰다.
        this.frames = 0;
        this.steps = 0;
        this.maxSteps = 200e6;
        this.depth = 0;
        this.maxDepth = 0;
    }

    byName(name) {
        for (const [id, v] of this.vars) if (v.name === name) return { id, ...v };
        throw new Error(`변수 없음: ${name}`);
    }

    setVar(name, value) { this.byName(name); this.vars.get(this.byName(name).id).value = value; }
    getVar(name) { return this.byName(name).value; }
    getList(name) { return this.byName(name).array; }

    /** 오브젝트의 '시작하기를 클릭했을 때' 스레드를 실행한다 (모듈 init 이 여기 들어 있다). */
    runStart(objName) {
        const obj = this.p.objects.find((o) => o.name === objName);
        const t = JSON.parse(obj.script).find((th) => th[0].type === 'when_run_button_click');
        if (!t) throw new Error(`시작 스레드 없음: ${objName}`);
        this.self = objName;
        this.execSeq(t.slice(1));
    }

    /** 오브젝트의 '키를 눌렀을 때' 스레드를 실행한다.
     *  ⚠ 같은 키에 걸린 스레드가 여러 개면 엔트리는 **전부** 실행한다.
     *     (브라우저와 nano 가 같은 오브젝트에서 같은 키를 쓰고 sh_view 로 가른다) */
    runKey(objName, keyCode) {
        const obj = this.p.objects.find((o) => o.name === objName);
        const ts = JSON.parse(obj.script).filter((th) => th[0].type === 'when_some_key_pressed'
            && String(th[0].params[1]) === String(keyCode));
        if (!ts.length) throw new Error(`키 스레드 없음: ${objName} / ${keyCode}`);
        this.self = objName;
        for (const t of ts) this.execSeq(t.slice(1));
    }

    /** 오브젝트의 '오브젝트를 클릭했을 때' 스레드를 실행한다 (Entry Browser 추가). */
    runClick(objName) {
        const obj = this.p.objects.find((o) => o.name === objName);
        if (!obj) throw new Error(`오브젝트 없음: ${objName}`);
        const ts = JSON.parse(obj.script).filter((th) => th[0].type === 'when_object_click');
        if (!ts.length) throw new Error(`클릭 스레드 없음: ${objName}`);
        this.self = objName;
        for (const t of ts) this.execSeq(t.slice(1));
    }

    /**
     * 함수를 이름으로 직접 부른다.
     * 화면 갱신이 신호가 아니라 **함수**인 설계라(경쟁 회피) 테스트도 그렇게 부른다.
     * @param objName 어느 오브젝트가 부른 것으로 볼지 (붓은 오브젝트별이다)
     */
    runFunc(name, objName) {
        for (const f of this.p.functions) {
            const create = JSON.parse(f.content)[0][0];
            if (create.params[0]?.params?.[0] === name) {
                const prev = this.self;
                if (objName) this.self = objName;
                this.execSeq(this.funcs.get(`func_${f.id}`));
                this.self = prev;
                return;
            }
        }
        throw new Error(`함수 없음: ${name}`);
    }

    /** 오브젝트의 '신호를 받았을 때' 스레드를 찾아 실행한다. */
    runSignal(objName, sigName) {
        const obj = this.p.objects.find((o) => o.name === objName);
        if (!obj) throw new Error(`오브젝트 없음: ${objName}`);
        const id = this.msg.get(sigName);
        const threads = JSON.parse(obj.script);
        const ts = threads.filter((th) => th[0].type === 'when_message_cast' && th[0].params[1] === id);
        if (!ts.length) throw new Error(`스레드 없음: ${objName} / ${sigName}`);
        const prev = this.self;
        this.self = objName;
        for (const t of ts) this.execSeq(t.slice(1));
        this.self = prev;       // 신호는 중첩될 수 있다 (autoSignal)
    }

    // ---------------------------------------------------------------- 실행
    execSeq(blocks) {
        for (const b of blocks) {
            const r = this.exec(b);
            if (r === BREAK) return BREAK;
        }
        return undefined;
    }

    exec(b) {
        if (++this.steps > this.maxSteps) throw new Error('스텝 상한 초과 — 무한 루프 의심');
        const P = b.params;
        const S = b.statements;

        switch (b.type) {
            case 'set_variable': this.vars.get(P[0]).value = this.ev(P[1]); return;
            case 'change_variable': {
                const v = this.vars.get(P[0]);
                v.value = Number(v.value) + Number(this.ev(P[1]));
                return;
            }
            case 'add_value_to_list': this.vars.get(P[1]).array.push(this.ev(P[0])); return;
            case 'remove_value_from_list': {
                const a = this.vars.get(P[1]).array;
                const i = Number(this.ev(P[0]));
                if (i < 1 || i > a.length) throw new Error(`리스트 삭제 범위 밖: ${i}/${a.length}`);
                a.splice(i - 1, 1);
                return;
            }
            case 'change_value_list_index': {
                const a = this.vars.get(P[0]).array;
                const i = Number(this.ev(P[1]));
                if (i < 1 || i > a.length) throw new Error(`리스트 쓰기 범위 밖: ${i}/${a.length}`);
                a[i - 1] = this.ev(P[2]);
                return;
            }
            case 'insert_value_to_list': {
                const a = this.vars.get(P[1]).array;
                a.splice(Number(this.ev(P[2])) - 1, 0, this.ev(P[0]));
                return;
            }

            case '_if': if (this.ev(P[0])) return this.execSeq(S[0]); return;
            case 'if_else': return this.execSeq(this.ev(P[0]) ? S[0] : S[1]);
            // ⚠ 프레임은 **한 바퀴를 마쳤을 때** 넘어간다.
            //   첫 바퀴에서 곧바로 break 하는 `until` 은 프레임을 안 먹는다.
            //   (처음엔 바퀴에 들어갈 때 셌더니, 조건이 이미 참인 루프까지
            //    1프레임으로 잡혀서 최적화 판단이 어긋났다)
            case 'repeat_inf':
                for (;;) {
                    if (this.execSeq(S[0]) === BREAK) return;
                    this.frames++;
                    if (++this.steps > this.maxSteps) throw new Error('스텝 상한 초과');
                }
            case 'repeat_basic': {
                const n = Number(this.ev(P[0]));
                for (let i = 0; i < n; i++) {
                    if (this.execSeq(S[0]) === BREAK) return;
                    this.frames++;
                }
                return;
            }
            case 'stop_repeat': return BREAK;
            case 'wait_second': return;

            case 'message_cast': {
                const name = [...this.msg].find(([, id]) => id === P[0])?.[0];
                this.log.signal.push(name);
                if (this.autoSignal) this.autoSignal(name);
                return;
            }

            // 글상자 — 어느 오브젝트가 무엇을 썼는지까지 기록한다.
            //   entry-ppt 는 글상자 풀이 화면의 절반이라, "누가 무엇을 썼나" 를
            //   못 보면 렌더러 테스트가 아무것도 검사하지 못한다.
            case 'text_write':
                this.log.text.push(String(this.ev(P[0])));
                this.wrote.set(this.self, String(this.ev(P[0])));
                return;
            case 'text_append': this.log.text.push(String(this.ev(P[0]))); return;
            case 'text_flush': this.wrote.set(this.self, ''); return;
            case 'text_change_font_color':
                this.fg.set(this.self, String(this.ev(P[0])));
                return;
            case 'text_change_bg_color':
                this.bg.set(this.self, String(this.ev(P[0])));
                return;
            // 글상자 서식. 🔴 **둘 다 필드**라 값이 블록이 아니라 문자열이다.
            //   풀은 상자를 돌려 쓰므로 "끄는 갈래가 빠지지 않았는가" 가 곧 정확성이다
            //   — 안 끄면 지난번에 굵게였던 슬롯이 다음 글에도 굵게 남는다.
            case 'text_change_effect': {
                if (!this.effect.has(this.self)) this.effect.set(this.self, new Set());
                const on = this.effect.get(this.self);
                if (P[1] === 'on') on.add(P[0]); else on.delete(P[0]);
                return;
            }
            case 'text_change_font': this.face.set(this.self, String(P[0])); return;
            case 'show_list': case 'hide_list': case 'stop_object': return;

            // 스프라이트 — 그림 풀이 쓴다. 어느 오브젝트가 어떤 모양을 얼마만큼
            // 키워 어디에 놓았는지까지 봐야 렌더러를 검사할 수 있다
            // (글상자에서 wrote/pos 를 기록하는 것과 같은 이유).
            case 'change_to_some_shape': this.shape.set(this.self, String(this.ev(P[0]))); return;
            case 'set_scale_size': this.scale.set(this.self, Number(this.ev(P[0]))); return;

            // AI 블록 (2026-08-03). 시뮬레이터는 **하는 척만** 한다 —
            // 진짜 동작은 엔트리 서버가 하므로 여기서 흉내낼 수 없다.
            // 대신 무엇을 시켰는지 기록해서 테스트가 "불렀는가"를 볼 수 있게 한다.
            case 'read_text': case 'read_text_wait_with_block':
                this.log.ai.push(['tts', this.ev(P[0])]);
                return;
            case 'set_tts_property':
                this.log.ai.push(['tts_set', P[0], P[1], P[2]]);
                return;
            case 'sound_from_to':
                this.log.sound.push([this.ev(P[0]), this.ev(P[1]), this.ev(P[2])]);
                return;
            case 'sound_something_with_block': this.log.sound.push([this.ev(P[0])]); return;

            // 붓 — 스냅샷은 **그려진 색이 곧 결과물**이라 획을 기록한다.
            //   (이미지 뷰어도 같은 블록을 쓰니 같이 잡힌다)
            case 'set_color': this.pen.color = String(this.ev(P[0])); return;
            case 'set_thickness': this.pen.size = Number(this.ev(P[0])); return;
            case 'start_drawing': this.pen.down = true; return;
            case 'stop_drawing': this.pen.down = false; return;
            case 'brush_erase_all': this.log.pen = []; return;
            case 'locate_xy': {
                const x = Number(this.ev(P[0]));
                const y = Number(this.ev(P[1]));
                if (this.pen.down) {
                    this.log.pen.push({
                        color: this.pen.color, size: this.pen.size,
                        x0: this.pen.x, y0: this.pen.y, x1: x, y1: y, owner: this.self,
                    });
                }
                this.pen.x = x; this.pen.y = y;
                this.pos.set(this.self, [x, y]);
                return;
            }

            // 보이기/숨기기 — 그림 풀은 "빈 슬롯이 숨었는가" 가 곧 정확성이다
            case 'create_clone': {
                const of = P[0] === 'self' ? this.self : this.p.objects.find((o) => o.id === P[0])?.name;
                if (!of) return;
                this.clones.push({
                    of, wrote: this.wrote.get(of), fg: this.fg.get(of), bg: this.bg.get(of), pos: this.pos.get(of),
                    shown: this.shown.get(of), effect: new Set(this.effect.get(of) || []),
                });
                if (this.clones.length > 5000) throw new Error('복제본이 너무 많다');
                return;
            }
            case 'remove_all_clones': this.clones = this.clones.filter((c) => c.of !== this.self); return;
            case 'delete_clone': return;
            case 'show': this.shown.set(this.self, true); return;
            case 'hide': this.shown.set(this.self, false); return;

            // 소리정지/시계 — 의미 검증과 무관
            case 'sound_silent_all':
            case 'choose_project_timer_action': case 'ask_and_wait':
                return;

            // 🔴 `~이 될 때까지 기다리기` — 명령이 사용자 입력을 기다리는 수단.
            //   시뮬레이터에는 사용자가 없으므로 테스트가 `sim.onWait` 로 그 자리를 채운다
            //   (보통은 "입력줄에 이 글을 치고 Enter" 를 흉내낸다).
            //   훅이 없는데 조건이 거짓이면 영원히 멈추므로 그때는 던진다.
            case 'wait_until_true': {
                for (let i = 0; i < 1000; i++) {
                    if (this.ev(P[0])) return;
                    if (!this.onWait) break;
                    this.onWait(this);
                }
                if (this.ev(P[0])) return;
                throw new Error('wait_until_true 가 안 풀린다 — sim.onWait 를 두세요');
            }

            default:
                if (this.funcs.has(b.type)) {
                    this.depth++;
                    this.maxDepth = Math.max(this.maxDepth, this.depth);
                    if (this.depth > 100000) throw new Error('재귀 폭주');
                    const r = this.execSeq(this.funcs.get(b.type));
                    this.depth--;
                    return r === BREAK ? BREAK : undefined;
                }
                throw new Error(`미지원 블록(문): ${b.type}`);
        }
    }

    // ---------------------------------------------------------------- 값
    ev(b) {
        if (b === null || b === undefined) return null;
        if (typeof b !== 'object') return b;
        const P = b.params;

        switch (b.type) {
            case 'number': return Number(P[0]);
            case 'text': return P[0];
            // 글상자 색. 붓의 `color` 와 같은 구조다 (Color 필드 하나).
            case 'text_color': return this.ev(P[0]);
            // 붓 색. 파라미터는 hex 문자열이거나, 색을 계산해 만든 블록이다
            case 'color': return this.ev(P[0]);

            // ⚠ 엔트리가 전부 바꾸는지 첫 개만 바꾸는지 확인 못 했다. 여기서는
            //   전부 바꾸는 쪽으로 둔다. 쓰는 곳(src/net.mjs)은 **둘 중 어느 쪽이어도**
            //   같은 결과가 나오게 짜여 있다 — 그 편이 안전하다.
            case 'calc_rand': {
                const a = Number(this.ev(P[1])); const b = Number(this.ev(P[3]));
                const lo = Math.min(a, b); const hi = Math.max(a, b);
                // ⚠ 시뮬레이터는 **재현 가능해야** 한다. 진짜 난수를 쓰면 테스트가
                //   돌 때마다 달라진다. 씨앗을 고정한 선형 합동 생성기를 쓴다.
                this.randState = ((this.randState || 12345) * 1103515245 + 12345) % 2147483648;
                return lo + (this.randState % (hi - lo + 1));
            }
            case 'change_string_case':
                return P[3] === 'toLowerCase'
                    ? String(this.ev(P[1])).toLowerCase()
                    : String(this.ev(P[1])).toUpperCase();

            case 'replace_string':
                return String(this.ev(P[1])).split(String(this.ev(P[3])))
                    .join(String(this.ev(P[5])));
            case 'True': return true;
            case 'False': return false;

            case 'get_variable': return this.vars.get(P[0]).value;
            case 'value_of_index_from_list': {
                const a = this.vars.get(P[1]).array;
                const i = Number(this.ev(P[3]));
                if (i < 1 || i > a.length) throw new Error(`리스트 읽기 범위 밖: ${i}/${a.length}`);
                return a[i - 1];
            }
            case 'length_of_list': return this.vars.get(P[1]).array.length;
            case 'is_included_in_list':
                return this.vars.get(P[1]).array.map(String).includes(String(this.ev(P[3])));

            case 'calc_basic': {
                const a = Number(this.ev(P[0])); const c = Number(this.ev(P[2]));
                switch (P[1]) {
                    case 'PLUS': return a + c;
                    case 'MINUS': return a - c;
                    case 'MULTI': return a * c;
                    case 'DIVIDE': return a / c;
                    default: throw new Error(`calc_basic ${P[1]}`);
                }
            }
            case 'quotient_and_mod': {
                const a = Number(this.ev(P[1])); const c = Number(this.ev(P[3]));
                return P[5] === 'QUOTIENT' ? Math.floor(a / c) : a % c;
            }
            case 'boolean_basic_operator': {
                let a = this.ev(P[0]); let c = this.ev(P[2]);
                // 엔트리는 양쪽이 숫자로 읽히면 숫자로 비교한다
                if (!isNaN(Number(a)) && !isNaN(Number(c)) && a !== '' && c !== '') {
                    a = Number(a); c = Number(c);
                } else { a = String(a); c = String(c); }
                switch (P[1]) {
                    case 'EQUAL': return a === c;
                    case 'NOT_EQUAL': return a !== c;
                    case 'GREATER': return a > c;
                    case 'LESS': return a < c;
                    case 'GREATER_OR_EQUAL': return a >= c;
                    case 'LESS_OR_EQUAL': return a <= c;
                    default: throw new Error(`cmp ${P[1]}`);
                }
            }
            // 🔴 엔트리는 **양쪽을 다 계산한 뒤** 합친다 (단락 평가가 없다).
            //   `줄이 있는가 그리고 리스트[그 줄]` 같은 식은 줄이 없을 때도 리스트를 읽어
            //   범위 밖 오류로 작품이 멈춘다. JS 처럼 && 로 흉내내면 그 사고를 못 잡는다
            //   (Entry Browser 실기: 빈 줄 위에 마우스를 올리면 튕겼다).
            case 'boolean_and_or': {
                const a = !!this.ev(P[0]);
                const b = !!this.ev(P[2]);
                return P[1] === 'AND' ? (a && b) : (a || b);
            }
            case 'boolean_not': return !this.ev(P[1]);

            case 'combine_something': return String(this.ev(P[1])) + String(this.ev(P[3]));
            case 'length_of_string': return String(this.ev(P[1])).length;
            case 'char_at': {
                const s = String(this.ev(P[1])); const i = Number(this.ev(P[3]));
                if (i < 1 || i > s.length) throw new Error(`char_at 범위 밖: ${i}/${s.length}`);
                return s[i - 1];
            }
            case 'substring': {
                const s = String(this.ev(P[1]));
                const a = Number(this.ev(P[3])); const c = Number(this.ev(P[5]));
                if (a < 1 || c < 1 || a > s.length || c > s.length) {
                    throw new Error(`substring 범위 밖: ${a}..${c}/${s.length}`);
                }
                return s.slice(a - 1, c);
            }
            case 'index_of_string':
                // 1-based, 못 찾으면 0
                return String(this.ev(P[1])).indexOf(String(this.ev(P[3]))) + 1;

            case 'get_project_timer_value': return 0;

            // 마우스 — 테스트가 sim.mouse 로 자리를 정해 준다
            case 'coordinate_mouse': return (this.mouse || { x: 0, y: 0 })[P[1]] ?? 0;
            case 'is_clicked': return !!this.mouseDown;

            // 번역은 서버가 한다. 흉내낼 수 없으므로 **표시만 붙여** 돌려준다.
            //   테스트는 "번역 블록을 거쳐 갔는가" 만 본다.
            case 'get_translated_string':
                this.log.ai.push(['translate', P[0], this.ev(P[1]), P[2]]);
                return `[${P[2]}]${this.ev(P[1])}`;

            // ⚠ blockdefs.json 에 추측으로 넣은 블록들 (docs/BLOCKS.md).
            //   시뮬레이터에서는 **틀렸을 때의 동작**(거짓/빈 값)을 흉내내어,
            //   폴백 경로가 제대로 도는지 볼 수 있게 한다.
            case 'is_press_some_key': return this.keys ? this.keys.has(String(P[0])) : false;
            case 'get_date': return { YEAR: 2026, MONTH: 7, DAY: 30, HOUR: 11, MINUTE: 0, SECOND: 0 }[P[0]] ?? 0;
            case 'get_canvas_input_value': return this.answer ?? '';

            default: throw new Error(`미지원 블록(값): ${b.type}`);
        }
    }
}

const BREAK = Symbol('break');
