// tools/dsl.mjs — 블록 JSON을 직접 만드는 DSL
//
// 왜 이게 있나: docs/CODEGEN.md
//   엔트리 파이썬은 손실 있는 텍스트 투영이라 리스트·함수·함수호출을 다룰 수 없고,
//   실패가 대개 조용하다. 블록 JSON은 엔트리의 실제 저장 형식이라 그런 제약이 없다.
//
// 파라미터 채우는 규칙은 blockdefs.json 의 타입만으로 결정된다:
//   Block            자식 블록 / 리터럴
//   DropdownDynamic  변수·리스트·신호의 id
//   Dropdown         고정 enum
//   TextInput        원시 값
//   Text/Indicator/LineBreak  항상 null (블록에 그려지는 장식)
//
// ⚠ 함수 매개변수는 쓰지 않는다.
//   함수 본문에서 매개변수를 참조하는 블록 표현이 미확인이라, 대신 전역 변수를 쓴다.
//   재귀 깊이에는 영향이 없고(상태는 어차피 전역이어야 한다) 구조도 단순해진다.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFS = JSON.parse(readFileSync(resolve(HERE, 'blockdefs.json'), 'utf8')).blocks;

// ---------------------------------------------------------------- id
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const usedIds = new Set();

function newId(len = 4) {
    for (let i = 0; i < 2000; i++) {
        let s = '';
        for (let j = 0; j < len; j++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
        if (!usedIds.has(s)) { usedIds.add(s); return s; }
    }
    throw new Error('id 생성 실패');
}

/**
 * 🔴 블록 트리를 **새 id 로 깊은 복사**한다.
 *
 * 왜 필요한가 — 이 DSL 은 블록 조각을 JS 상수로 두고 여러 곳에 펼쳐 쓴다:
 *     const takeOpt = [ ... ];   →  head, tail, wc, rm, uniq 가 전부 `...takeOpt`
 *     const idx = add(get(V.na_top), num(i));   →  같은 식을 두 자리에서 참조
 * 그러면 **같은 블록 객체가 프로젝트 여러 곳에 그대로 들어간다.** JSON 으로 굳으면
 * 같은 id 가 여러 번 나타나는데, 블록 JSON 에서 id 는 유일해야 한다.
 * 엔트리는 id 로 블록 맵을 세우므로 로더가 거기서 넘어진다 —
 * **오브젝트 목록조차 안 뜨는** 증상이 그것이다 (2026-07-31).
 *
 * 고치는 자리를 한 곳으로 모은다: 모듈은 지금처럼 편하게 상수를 재사용하고,
 * **굳히기 직전에** 여기서 전부 새 id 로 복사한다.
 */
function freshIds(node) {
    if (Array.isArray(node)) return node.map(freshIds);
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
        if (k === 'id' && typeof v === 'string') out[k] = newId();
        else if (k === 'params' || k === 'statements') out[k] = freshIds(v);
        else out[k] = v;
    }
    return out;
}

// ---------------------------------------------------------------- 블록 생성
const NULL_TYPES = new Set(['Text', 'Indicator', 'LineBreak', 'Output']);

// 반드시 채워야 하는 자리인지 판정한다.
//   - 무언가를 가리켜야 하는 타입 (변수 id, enum, 원시값)
//   - def 에 기본값이 있는 자리 (엔트리가 그 자리에 블록/값을 기대한다는 뜻)
// repeat_inf 의 params[1] 처럼 스키마에는 Block 이지만 def 에 없는 자리는 안 채워도 된다.
const MUST_FILL_TYPES = new Set(['DropdownDynamic', 'Dropdown', 'TextInput', 'Keyboard', 'Color']);

// 블록에 **박힌 필드**. 값 슬롯이 아니라서 식을 꽂아도 평가되지 않는다.
// (DropdownDynamic 은 변수 id 를 담는 필드지만 id 는 문자열이라 여기 넣어도 무방하다)
const FIELD_TYPES = new Set(['Dropdown', 'Keyboard', 'Color', 'DropdownDynamic']);

function isRequired(def, ptype, i) {
    if (NULL_TYPES.has(ptype)) return false;
    if (MUST_FILL_TYPES.has(ptype)) return true;
    return def.d != null && def.d[i] != null;
}

/**
 * @param {string} type      블록 타입
 * @param {object} fills     { 파라미터인덱스: 값 }
 * @param {array[]} stmts    statements (각 원소는 블록 배열)
 */
export function mk(type, fills = {}, stmts = []) {
    const def = DEFS[type];
    if (!def) throw new Error(`blockdefs.json 에 없는 블록: ${type}`);

    // 채워야 할 자리를 빠뜨렸는지 빌드 단계에서 잡는다.
    // 엔트리는 잘못된 블록을 조용히 무시하므로, 여기서 막지 않으면 런타임에 원인을 못 찾는다.
    def.p.forEach((ptype, i) => {
        if (isRequired(def, ptype, i) && !(i in fills)) {
            throw new Error(`${type}: 파라미터 ${i} (${ptype}) 가 비었습니다`);
        }
        // 오타 난 변수 이름(V.없는이름)은 undefined 로 들어온다.
        // 자리는 채워졌으니 위 검사를 통과하고, 엔트리에서는 조용히 아무 일도 안 하게 된다.
        if (i in fills && fills[i] == null) {
            throw new Error(`${type}: 파라미터 ${i} (${ptype}) 에 undefined 가 들어왔습니다`
                + ' — 변수/리스트/신호 이름 오타일 가능성이 높습니다');
        }
        // 🔴 **필드에는 블록을 꽂을 수 없다.**
        //   Color/Dropdown/Keyboard/TextInput 은 값 슬롯이 아니라 블록에 박힌 필드다.
        //   엔트리는 그 자리를 평가하지 않고 저장된 값을 그대로 읽는다.
        //   블록을 넣으면 예외 없이 **조용히 엉뚱한 값**이 된다.
        //   실제로 스냅샷 격자가 통째로 검게 나왔다 — 계산한 색을 `color` 블록의
        //   Color 필드에 넣었기 때문이다. 색을 계산하려면 `color` 를 거치지 말고
        //   set_color 의 Block 슬롯에 식을 직접 꽂아야 한다.
        if (i in fills && FIELD_TYPES.has(ptype)
            && typeof fills[i] === 'object' && fills[i] !== null) {
            throw new Error(`${type}: 파라미터 ${i} 는 ${ptype} **필드**입니다 —`
                + ` 블록(${fills[i].type})을 꽂을 수 없습니다. 리터럴을 넣거나,`
                + ' 값을 계산해야 한다면 Block 슬롯을 받는 블록을 쓰세요');
        }
    });

    const params = def.p.map((_, i) => (i in fills ? fills[i] : null));

    const statements = [];
    for (let i = 0; i < (def.s || 0); i++) statements.push(stmts[i] || []);

    return {
        id: newId(), x: 0, y: 0, type, params, statements,
        movable: null, deletable: 1, emphasized: false, readOnly: null,
        copyable: true, assemble: true, extensions: [],
    };
}

// ---------------------------------------------------------------- 리터럴 / 식
export const num = (v) => mk('number', { 0: String(v) });
export const text = (v) => mk('text', { 0: String(v) });
export const TRUE = () => mk('True', {});

const lit = (v) => (typeof v === 'object' && v !== null ? v : (typeof v === 'number' ? num(v) : text(v)));

// 산술
const calc = (op) => (a, b) => mk('calc_basic', { 0: lit(a), 1: op, 2: lit(b) });
export const add = calc('PLUS');
export const sub = calc('MINUS');
export const mul = calc('MULTI');
export const div = calc('DIVIDE');
export const quotient = (a, b) => mk('quotient_and_mod', { 1: lit(a), 3: lit(b), 5: 'QUOTIENT' });
export const mod = (a, b) => mk('quotient_and_mod', { 1: lit(a), 3: lit(b), 5: 'MOD' });

// 비교 / 논리
const cmp = (op) => (a, b) => mk('boolean_basic_operator', { 0: lit(a), 1: op, 2: lit(b) });
export const eq = cmp('EQUAL');
export const ne = cmp('NOT_EQUAL');
export const gt = cmp('GREATER');
export const lt = cmp('LESS');
export const ge = cmp('GREATER_OR_EQUAL');
export const le = cmp('LESS_OR_EQUAL');
export const and = (a, b) => mk('boolean_and_or', { 0: a, 1: 'AND', 2: b });
export const or = (a, b) => mk('boolean_and_or', { 0: a, 1: 'OR', 2: b });
export const not = (a) => mk('boolean_not', { 1: a });

// 문자열
export const concat = (a, b) => mk('combine_something', { 1: lit(a), 3: lit(b) });
export const charAt = (s, i) => mk('char_at', { 1: lit(s), 3: lit(i) });
export const substring = (s, a, b) => mk('substring', { 1: lit(s), 3: lit(a), 5: lit(b) });
export const indexOf = (s, t) => mk('index_of_string', { 1: lit(s), 3: lit(t) });
export const replace = (s, a, b) => mk('replace_string', { 1: lit(s), 3: lit(a), 5: lit(b) });
export const strLen = (s) => mk('length_of_string', { 1: lit(s) });

// ⚠ 아래 둘은 blockdefs.json 에 **추측으로 넣은** 정의다 (_guess).
//   엔트리에 이 블록들이 있다는 것은 확실하고, 파라미터 모양도 같은 꼴의 값 블록
//   (index_of_string, combine_something)과 같게 잡았다. 다만 에디터에서 뽑은 것은
//   아니므로, 쓰는 쪽에 **틀려도 죽지 않는 폴백**을 함께 둔다.
export const randInt = (a, b) => mk('calc_rand', { 1: lit(a), 3: lit(b) });
export const strCase = (s, kind) => mk('change_string_case', { 1: lit(s), 3: kind });
export const UPPER = 'toUpperCase';
export const LOWER = 'toLowerCase';

// 입력 / 시계
export const answer = () => mk('get_canvas_input_value', {});
export const ask = (q) => mk('ask_and_wait', { 0: lit(q) });
export const timerValue = () => mk('get_project_timer_value', {});

// ⚠ 아래 둘은 blockdefs.json 에 **추측으로 넣은** 정의다 (_guess 표시).
//   틀리면 조용히 거짓/빈 값이 나온다. 그래서 쓰는 쪽에 반드시 대안을 둔다.
export const keyPressed = (code) => mk('is_press_some_key', { 0: String(code) });
export const dateOf = (part) => mk('get_date', { 0: part });
export const timer = (action) => mk('choose_project_timer_action', { 1: action });

// 출력
export const say = (v) => mk('dialog', { 0: lit(v), 1: 'speak' });
export const hideSelf = () => mk('hide', {});
export const showSelf = () => mk('show', {});

// 글상자
export const writeText = (v) => mk('text_write', { 0: lit(v) });
export const appendText = (v) => mk('text_append', { 0: lit(v) });
export const clearText = () => mk('text_flush', {});
// 🔴 붓과 **같은 함정**이다. text_color 블록의 파라미터는 Color 필드라 식을 꽂아도
//   평가되지 않는다. 리터럴이면 감싸고, 계산한 값이면 Block 슬롯에 직접 넣는다.
export const textColor = (hex) => mk('text_change_font_color', {
    0: typeof hex === 'string' ? mk('text_color', { 0: hex }) : lit(hex),
});
export const textBgColor = (hex) => mk('text_change_bg_color', {
    0: typeof hex === 'string' ? mk('text_color', { 0: hex }) : lit(hex),
});
// 🔴 **글상자에는 넣지 말 것.** `set_scale_size` 를 글상자 스크립트에 넣으면
//   작품 불러오기가 깨진다 (entry-os docs/BLOCKS.md 2026-07-31).
//   스프라이트에는 쓴다 — 그림 크기를 런타임에 바꾸는 유일한 수단이다.
// 글상자 서식. 🔴 **둘 다 필드다** — 식을 꽂을 수 없어서 쓰는 쪽이 갈래로 편다.
//   (필드에 블록을 넣으면 평가되지 않고 저장값이 읽힌다 — mk() 가 막는다)
export const EFFECTS = { bold: 'fontBold', italic: 'fontItalic', under: 'underLine', strike: 'strike' };
export const textEffect = (effect, on) =>
    mk('text_change_effect', { 0: effect, 1: on ? 'on' : 'off' });
export const textFont = (family) => mk('text_change_font', { 0: family });

export const setSize = (n) => mk('set_scale_size', { 0: lit(n) });

// 모양 바꾸기. 파라미터는 드롭다운처럼 보이지만 `getStringValue` 로 **평가**되므로
// 식(변수·리스트에서 꺼낸 번호)을 그대로 꽂을 수 있다 (blockdefs 의 _source 참고).
export const setShape = (nameExpr) => mk('change_to_some_shape', { 0: lit(nameExpr) });

// 붓
export const penDown = () => mk('start_drawing', {});
export const penUp = () => mk('stop_drawing', {});
// 🔴 색을 **계산**할 때는 `color` 블록을 거치면 안 된다.
//   `set_color.params[0]` 은 Block 슬롯(값 자리)이지만, 그 안에 넣는 `color` 블록의
//   파라미터는 Color **필드**다. 필드는 평가되지 않고 저장된 값이 그대로 읽힌다.
//   → 리터럴 hex 면 `color` 블록으로 감싸고(에디터에 색 견본으로 보인다),
//     식이면 **슬롯에 직접** 꽂는다.
//   실기에서 스냅샷 격자가 통째로 검게 나와서 알았다 (2026-07-30).
//   같은 이유로 image.mjs 의 팔레트 색(리스트에서 꺼낸 값)도 여태 안 먹고 있었다.
export const penColor = (hex) => mk('set_color', {
    0: typeof hex === 'string' ? mk('color', { 0: hex }) : lit(hex),
});
export const penSize = (n) => mk('set_thickness', { 0: lit(n) });
export const penClear = () => mk('brush_erase_all', {});

// 소리
// ⚠ 소리 이름 자리는 원래 드롭다운(get_sounds)이지만, 구현이 getStringValue 로
//   **평가**하므로 이름을 담은 식(변수·문자열 조합)을 그대로 꽂을 수 있다.
export const playSound = (nameExpr) => mk('sound_something_with_block', { 0: lit(nameExpr) });
export const playSoundWait = (nameExpr) => mk('sound_something_wait_with_block', { 0: lit(nameExpr) });
export const stopAllSound = () => mk('sound_silent_all', { 0: 'all' });
// 한 파일의 특정 구간만 재생한다. 사운드 뱅크에서 음 하나를 골라낼 때 쓴다.
export const playSoundFromTo = (nameExpr, startSec, endSec) =>
    mk('sound_from_to', { 0: lit(nameExpr), 1: lit(startSec), 2: lit(endSec) });

// 움직임
export const moveTo = (x, y) => mk('locate_xy', { 0: lit(x), 1: lit(y) });

// 마우스 (2026-08-03 추가 — entryjs 소스에서 스키마를 뽑았다)
// ⚠ 아직 **실기 확인 전**이다. blockdefs.json 의 _source 표시를 볼 것.
//   틀리면 조용히 아무 일도 안 하므로, 명령줄이 그대로 남아 있는 것이 폴백이다.
export const mouseX = () => mk('coordinate_mouse', { 1: 'x' });
export const mouseY = () => mk('coordinate_mouse', { 1: 'y' });
export const isClicked = () => mk('is_clicked', {});

// 복제본. DropdownDynamic 이지만 값은 변수 id 가 아니라 'self' 또는 오브젝트 id 다.
export const makeCloneOf = (who = 'self') => mk('create_clone', { 0: who });
export const removeThisClone = () => mk('delete_clone', {});
export const removeAllClones = () => mk('remove_all_clones', {});

// AI — 읽어주기 / 번역 (계획서 §5)
// ⚠ project.json 의 aiUtilizeBlocks 에 'tts' / 'translate' 가 들어가야 한다
//   (defineProject 의 spec.aiUtilize).
export const readText = (v) => mk('read_text', { 0: lit(v) });
export const readTextWait = (v) => mk('read_text_wait_with_block', { 0: lit(v) });
export const setTtsProperty = (voice = 'kyuri', speed = '0', pitch = '0') =>
    mk('set_tts_property', { 0: voice, 1: speed, 2: pitch });
export const translate = (from, v, to) =>
    mk('get_translated_string', { 0: from, 1: lit(v), 2: to });

// 흐름
export const forever = (body) => mk('repeat_inf', {}, [body]);
export const repeat = (n, body) => mk('repeat_basic', { 0: lit(n) }, [body]);
export const ifDo = (cond, body) => mk('_if', { 0: cond }, [body]);
export const ifElse = (cond, a, b) => mk('if_else', { 0: cond }, [a, b]);
export const breakLoop = () => mk('stop_repeat', {});
export const wait = (sec) => mk('wait_second', { 0: lit(sec) });
// 🔴 명령이 사용자 입력을 **기다리는** 수단.
//   신호로 하면 명령 스레드가 그냥 지나가 빈 값을 읽는다 (src/input.mjs 주석).
export const waitUntil = (cond) => mk('wait_until_true', { 0: cond });
export const stopAll = () => mk('stop_object', { 0: 'all' });

// ---------------------------------------------------------------- 프로젝트
export function defineProject(spec) {
    const sceneId = newId();

    // 선언은 문자열이거나 { name, ... } 객체다
    const decl = (item) => (typeof item === 'string' ? { name: item } : item);

    // 🔴 이름이 겹치면 조용히 엉뚱한 것을 가리킨다.
    //   변수 `pk_name` 과 리스트 `pk_name` 을 같이 선언한 적이 있다. 블록은 V/L 이
    //   갈라져 있어서 멀쩡히 돌지만, **이름으로 찾는 모든 것**이 깨진다 —
    //   시뮬레이터의 getList 도, 엔트리의 변수 목록도. 여기서 막는다.
    {
        const seen = new Map();
        const claim = (name, kind) => {
            if (seen.has(name)) {
                throw new Error(`이름이 겹칩니다: '${name}' (${seen.get(name)} / ${kind})`
                    + ' — 변수·리스트·함수는 서로 다른 이름이어야 합니다');
            }
            seen.set(name, kind);
        };
        for (const v of spec.variables || []) claim(decl(v).name, '변수');
        for (const l of spec.lists || []) claim(decl(l).name, '리스트');
        for (const f of spec.functions || []) claim(decl(f).name, '함수');
    }

    const V = {};   // 변수 이름 -> id
    const L = {};   // 리스트 이름 -> id
    const S = {};   // 신호 이름 -> id
    const F = {};   // 함수 이름 -> id

    const variables = [];
    const functions = [];
    const messages = [];

    // 내장 변수 (없으면 초시계/대답 관련 블록이 깨진다)
    variables.push({
        name: '초시계', id: newId(), visible: false, value: '0', variableType: 'timer',
        isCloud: false, isRealTime: false, cloudDate: false, object: null, x: 134, y: -70,
    });
    variables.push({
        name: '대답', id: newId(), visible: false, value: '0', variableType: 'answer',
        isCloud: false, isRealTime: false, cloudDate: false, object: null, x: 150, y: -100,
    });

    // 이름 문자열 대신 { name, cloud, realtime, visible, x, y } 객체로도 줄 수 있다.
    // cloud/realtime 은 **공유(실시간) 변수·리스트** 플래그다.
    // ⚠ 필드 이름은 실제 작품에서 뽑은 것이라 확실하지만 **동작은 미확인**이다 (p08).

    for (const item of spec.variables || []) {
        const q = decl(item);
        const id = newId();
        V[q.name] = id;
        variables.push({
            name: q.name, id, visible: !!q.visible, value: '0', variableType: 'variable',
            isCloud: !!q.cloud, isRealTime: !!q.realtime, cloudDate: false,
            object: null, x: q.x || 0, y: q.y || 0,
        });
    }

    for (const item of spec.lists || []) {
        const q = decl(item);
        const id = newId();
        L[q.name] = id;
        variables.push({
            name: q.name, id, visible: !!q.visible, value: 0, variableType: 'list',
            isCloud: !!q.cloud, isRealTime: !!q.realtime, cloudDate: false, object: null,
            x: q.x || 0, y: q.y || 0, array: [],
            width: q.width || 200, height: q.height || 300, scrollPosition: 0,
        });
    }

    for (const name of spec.signals || []) {
        const id = newId();
        S[name] = id;
        messages.push({ id, name });
    }

    // 함수는 이름만 먼저 등록한다. 본문은 defineFunction 으로 나중에 채운다
    // (재귀 함수가 자기 자신을 호출해야 하므로 id 가 먼저 있어야 한다).
    for (const name of spec.functions || []) F[name] = newId();

    // ---- 변수/리스트 접근자 ----
    const get = (id) => mk('get_variable', { 0: id });
    const set = (id, v) => mk('set_variable', { 0: id, 1: lit(v) });
    const inc = (id, v) => mk('change_variable', { 0: id, 1: lit(v) });

    const listAdd = (id, v) => mk('add_value_to_list', { 0: lit(v), 1: id });
    const listPop = (id, i) => mk('remove_value_from_list', { 0: lit(i), 1: id });
    const listInsert = (id, i, v) => mk('insert_value_to_list', { 0: lit(v), 1: id, 2: lit(i) });
    const listSet = (id, i, v) => mk('change_value_list_index', { 0: id, 1: lit(i), 2: lit(v) });
    const listGet = (id, i) => mk('value_of_index_from_list', { 1: id, 3: lit(i) });
    const listLen = (id) => mk('length_of_list', { 1: id });
    const listHas = (id, v) => mk('is_included_in_list', { 1: id, 3: lit(v) });
    const listShow = (id) => mk('show_list', { 0: id });
    const listHide = (id) => mk('hide_list', { 0: id });

    // ⚠ 리스트 인덱스: 블록은 1-based다 (파이썬 모드에서만 변환기가 +1 해준다 — p01).
    //    코드젠에서는 보정이 없으므로 여기서 명시적으로 +1 한다.
    const idx = (i) => (typeof i === 'number' ? num(i + 1) : add(i, num(1)));

    // ---- 신호 ----
    const sendSignal = (name) => mk('message_cast', { 0: S[name] });

    // ---- 그림 애셋 ----
    // 🔴 형식은 entry-os 가 실제 `.eo` 를 뜯어서 확정했다 (docs/BLOCKS.md 2026-08-02).
    //   · `filename` 은 **32글자**. 경로 샤딩이 여기서 나온다 (앞 2 / 그다음 2)
    //   · 아카이브 안 경로와 `fileurl` 이 **다르다**:
    //       .ent 안 실제 경로 =  temp/<2>/<2>/image/<filename>.<ext>
    //       fileurl          =  temp/<2>/<2>/image/<filename>.<ext>   (작품 기준이라 같다)
    //     (`.eo` 로 내보낼 때만 컨테이너 루트가 object/ 로 바뀐다)
    //   · thumb/ 에 축소본이 함께 들어간다. **필수인지는 미확인**이라 같은 것을 넣는다.
    //
    // ⚠ 아직 실기 확인 전이다 — 우리가 지은 filename 을 엔트리가 받아 주는지,
    //   SVG 를 받아 주는지 둘 다 (entry-os probes/p13). 그래서 그림이 안 떠도
    //   프로그램이 도는 자리에만 쓴다.
    const assets = [];          // { path, data } — build.mjs 가 tar 에 넣는다

    const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
    function assetName() {
        let s = '';
        for (let i = 0; i < 32; i++) s += ALNUM[Math.floor(Math.random() * ALNUM.length)];
        return s;
    }

    /**
     * 소리 하나를 프로젝트에 넣고 sound 항목을 돌려준다.
     *
     * 🔴 그림과 **같은 규칙**이다 — 경로만 image/ 가 아니라 sound/ 다.
     *   entry-os 는 `fileurl` 에 data URI 를 넣는 길을 뚫었지만, `.ent` 를 열어
     *   실행하는 경로에서는 무음이었다 (entry-ppt/src/sounds.mjs 주석).
     *   그림 애셋 경로는 실기로 확인됐으므로 그쪽을 흉내낸다.
     *
     * ⚠ `ext` 는 **점을 포함**한다 ('.wav'). 엔트리의 소리 항목이 그 꼴이고,
     *   SoundJS 가 URL 확장자로 타입을 판별하므로 뒤에 붙는 것도 그대로여야 한다.
     * @param {{name, ext, data, duration}} q
     */
    function addSound(q) {
        const filename = assetName();
        const a = filename.slice(0, 2);
        const b = filename.slice(2, 4);
        const ext = q.ext || '.wav';
        const url = `temp/${a}/${b}/sound/${filename}${ext}`;
        assets.push({ path: url, data: q.data });
        return {
            id: newId(),
            name: q.name,
            filename,
            ext,
            fileurl: url,
            // 🔴 0 이거나 없으면 Entry.initSound 이 아무것도 안 한다
            duration: q.duration || 0.1,
        };
    }

    /**
     * 그림 하나를 프로젝트에 넣고 picture 항목을 돌려준다.
     * @param {{name, ext, data, width, height}} q
     */
    function addPicture(q) {
        const filename = assetName();
        const a = filename.slice(0, 2);
        const b = filename.slice(2, 4);
        const url = `temp/${a}/${b}/image/${filename}.${q.ext}`;
        const thumb = `temp/${a}/${b}/thumb/${filename}.${q.ext}`;
        assets.push({ path: url, data: q.data });
        assets.push({ path: thumb, data: q.data });
        return {
            id: newId(),
            name: q.name,
            filename,
            imageType: q.ext,
            fileurl: url,
            // 🔴 thumbUrl 이 없으면 불러올 때는 그림이 다 보여도 **저장하면 안 남는다** — 모양 탭에서
            //   그림마다 [저장하기]를 눌러야 했다 (entry-browser, 2026-10-26 · 두 번째). 엔트리가 저장하는
            //   그림 항목(entryjs Entry.getPicturesJSON)에는 thumbUrl 이 있고, 섬네일 파일을 넣었으면 가리켜야 한다.
            thumbUrl: thumb,
            dimension: {
                width: q.width, height: q.height,
                scaleX: 1, scaleY: 1,
            },
        };
    }

    // ---- 오브젝트 ----
    // ⚠ 배열 순서가 곧 레이어 순서다. **먼저 만든 것이 앞(위)** 이다.
    //    배경은 마지막에 만들어야 뒤로 간다.
    const objects = [];

    function makeObject(name, kind, props) {
        const o = { id: newId(), name, kind, props, threads: [], layoutY: 20 };
        objects.push(o);
        return o;
    }

    const sprite = (name, props = {}) => makeObject(name, 'sprite', props);

    /**
     * 글상자. 터미널의 각 행과 배경 패널이 전부 이것이다.
     * w/h 를 주면 lineBreak 를 켜서 고정 크기 상자가 된다 (안 켜면 글자 길이에 맞춰 줄어든다).
     */
    const textBox = (name, props = {}) => makeObject(name, 'textBox', props);

    function thread(obj, head, body) {
        head.x = 20;
        head.y = obj.layoutY;
        obj.layoutY += 120 + body.length * 40;
        obj.threads.push([head, ...body]);
    }

    const onStart = (obj, body) => thread(obj, mk('when_run_button_click', {}), body);
    // 오브젝트를 클릭했을 때 / 마우스를 클릭했을 때 (마우스 GUI 의 두 축)
    const onClick = (obj, body) => thread(obj, mk('when_object_click', {}), body);
    const onMouse = (obj, body) => thread(obj, mk('mouse_clicked', {}), body);
    const onSignal = (obj, name, body) => thread(obj, mk('when_message_cast', { 1: S[name] }), body);
    // keyCode 는 브라우저 keyCode (a=65, 0=48, Enter=13, Backspace=8, Space=32)
    const onKey = (obj, keyCode, body) => thread(obj, mk('when_some_key_pressed', { 1: String(keyCode) }), body);

    // ---- 함수 ----
    function defineFunction(name, body) {
        const id = F[name];
        if (!id) throw new Error(`함수가 spec.functions 에 없습니다: ${name}`);
        const label = mk('function_field_label', { 0: name });
        const create = mk('function_create', { 0: label }, [body]);
        create.x = 40; create.y = 40;
        create.deletable = false; create.copyable = false;
        functions.push({
            id, type: 'normal',
            content: JSON.stringify(freshIds([[create]])),
            localVariables: [], useLocalVariables: false,
        });
    }

    // 함수 호출 블록. 매개변수 없이 쓴다(위 주석 참고).
    function call(name) {
        const id = F[name];
        if (!id) throw new Error(`알 수 없는 함수: ${name}`);
        return {
            id: newId(), x: 0, y: 0, type: `func_${id}`, params: [], statements: [],
            movable: null, deletable: 1, emphasized: false, readOnly: null,
            copyable: true, assemble: true, extensions: [],
        };
    }

    // ---- 산출 ----
    function emitObject(o) {
        const base = {
            id: o.id,
            name: o.name,
            script: JSON.stringify(freshIds(o.threads)),
            rotateMethod: 'free',
            scene: sceneId,
            lock: false,
        };

        if (o.kind === 'textBox') {
            const q = o.props;
            const w = q.w != null ? q.w : 100;
            const h = q.h != null ? q.h : 24;
            const size = q.size || 12;
            return {
                ...base,
                objectType: 'textBox',
                sprite: { pictures: [], sounds: [] },
                text: q.text != null ? q.text : '',
                entity: {
                    x: q.x || 0, y: q.y || 0,
                    // regX/regY 는 항상 크기의 절반이다 (엔트리 기본 오브젝트에서 확인)
                    regX: w / 2, regY: h / 2,
                    scaleX: 1, scaleY: 1, rotation: 0, direction: 90,
                    width: w, height: h,
                    font: `${size}px ${q.font || 'D2 Coding'}`,
                    fontSize: size,
                    visible: q.visible !== false,
                    colour: q.color || '#ffffff',
                    bgColor: q.bgColor || 'transparent',
                    text: q.text != null ? q.text : '',
                    textAlign: q.align != null ? q.align : 1,   // 0 가운데 / 1 왼쪽 / 2 오른쪽
                    lineBreak: q.w != null,                     // 고정 크기 상자로 쓰려면 켜야 한다
                    underLine: false, strike: false,
                },
            };
        }

        // props.pictures 를 주면 그것을 쓴다 (커스텀 그림). 없으면 기본 엔트리봇.
        const custom = (o.props.pictures || []).map(addPicture);
        const picIds = [newId(), newId()];
        const pictures = custom.length ? custom : [
            { id: picIds[0], name: '엔트리봇_걷기1', fileurl: '/lib/entry-js/images/media/entrybot1.svg', imageType: 'svg', dimension: { width: 144, height: 246 } },
            { id: picIds[1], name: '엔트리봇_걷기2', fileurl: '/lib/entry-js/images/media/entrybot2.svg', imageType: 'svg', dimension: { width: 144, height: 246 } },
        ];
        const first = pictures[0];
        return {
            ...base,
            objectType: 'sprite',
            sprite: {
                pictures,
                // props.sounds 로 직접 만든 음원을 넣는다.
                //   { name, ext, duration, data }  -> 애셋 파일로 번들 (addSound)
                //   { name, ext, duration, fileurl } -> 주소를 그대로 (data URI 포함)
                // ⚠ data URI 는 `.ent` 를 열어 실행하는 경로에서 무음이었다
                //   (entry-os src/synth.mjs). 새로 넣는 것은 애셋 파일 쪽을 쓴다.
                sounds: (o.props.sounds || []).map((s) => (s.data ? addSound(s) : {
                    id: newId(),
                    name: s.name,
                    fileurl: s.fileurl,
                    ext: s.ext || '.wav',
                    duration: s.duration,
                })),
            },
            selectedPictureId: first.id,
            entity: (() => {
                const W = first.dimension.width;
                const H = first.dimension.height;
                // 화면에 놓일 크기를 주면 그만큼 줄여 놓는다 (안 주면 기본 엔트리봇 비율)
                const sc = o.props.w ? o.props.w / W : (custom.length ? 1 : 0.5128205128205128);
                return {
                    x: o.props.x || 0, y: o.props.y || 0,
                    // regX/regY 는 항상 원본 크기의 절반이다 (entry-os 실측)
                    regX: W / 2, regY: H / 2,
                    scaleX: sc, scaleY: sc,
                    rotation: 0, direction: 90, width: W, height: H,
                    font: 'undefinedpx ', visible: o.props.visible !== false,
                };
            })(),
        };
    }

    /** build.mjs 가 tar 에 넣을 그림 파일들 */
    function assetFiles() { return assets; }

    function toProject() {
        if (!objects.length) throw new Error('오브젝트가 하나도 없습니다');
        const out = {
            objects: objects.map(emitObject),
            scenes: [{ id: sceneId, name: '장면 1' }],
            variables,
            messages,
            functions,
            tables: [],
            speed: spec.speed || 60,
            interface: {},
            expansionBlocks: [],
            // AI 블록을 쓰려면 여기 이름이 들어가야 한다 ('tts', 'translate' …).
            aiUtilizeBlocks: spec.aiUtilize || [],
            hardwareLiteBlocks: [],
            learning: {},
            externalModules: [],
            externalModulesLite: [],
        };

        // 🔴 id 가 유일한지 **굳힌 뒤에** 다시 센다.
        //   freshIds 가 빠진 자리가 생기면 여기서 걸린다. 이 환경의 실패는 대부분
        //   침묵이고, 이건 그중에서도 최악이다 — 불러오기 자체가 안 된다.
        const seen = new Set();
        const dup = [];
        const scan = (b) => {
            if (Array.isArray(b)) return b.forEach(scan);
            if (!b || typeof b !== 'object') return;
            if (typeof b.id === 'string') {
                if (seen.has(b.id)) dup.push(`${b.id}(${b.type})`);
                else seen.add(b.id);
            }
            (b.params || []).forEach(scan);
            (b.statements || []).forEach(scan);
        };
        out.objects.forEach((o) => scan(JSON.parse(o.script)));
        out.functions.forEach((f) => scan(JSON.parse(f.content)));
        if (dup.length) {
            throw new Error(`블록 id 가 ${dup.length}개 겹칩니다 — 엔트리가 불러오지 못합니다.`
                + ` 예: ${dup.slice(0, 5).join(', ')}`);
        }

        return out;
    }

    return {
        V, L, S, F,
        get, set, inc,
        listAdd, listPop, listInsert, listSet, listGet, listLen, listHas, listShow, listHide, idx,
        sendSignal, onStart, onSignal, onKey, onClick, onMouse, defineFunction, call,
        sprite, textBox,
        toProject, assetFiles,
    };
}
