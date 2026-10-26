// src/syll.mjs — 한글 음절 11,172자 표 (가..힣)
//
// 엔트리에는 chr()/ord() 가 없다. 이 문자열이 그 대신이다:
//   chr(c)  = charAt(SYLL, c - 0xAC00 + 1)
//   ord(ch) = indexOf(SYLL, ch) + 0xAC00 - 1
// 문자열에는 리스트의 5000항목 상한이 없어서 통째로 들어간다.

export const SYLL = Array.from({ length: 11172 }, (_, i) => String.fromCharCode(0xAC00 + i)).join('');
