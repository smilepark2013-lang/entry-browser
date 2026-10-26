// src/render-preload.cjs — 렌더 모드 창에 넣는 유일한 코드
//
// 보이지 않는 창이라 alert()/confirm()/prompt()/print() 가 뜨면 사용자 화면에 갑자기
// 대화상자가 튀어나오거나 페이지가 멈춘다. 페이지 스크립트보다 먼저 조용한 것으로 바꿔 둔다.
// 페이지에는 아무것도 열어 주지 않는다 (contextBridge.exposeInMainWorld 없음).
const { contextBridge } = require('electron');

contextBridge.executeInMainWorld({
    func: () => {
        window.alert = () => {};
        window.confirm = () => false;
        window.prompt = () => null;
        window.print = () => {};
    },
});
