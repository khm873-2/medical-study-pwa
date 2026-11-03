// 글 속에 끼우는 작은 SVG 아이콘 — 이모지 대신 쓴다.
// 이모지는 기기·OS마다 모양이 달라 화면의 톤이 흔들리고(특히 ✅❌), 색을 테마에 맞출 수도 없다.
// 여기 아이콘은 currentColor 선이라 글자색·다크모드를 그대로 따라간다. (2026-11-03)

const P = {
  check:   '<path d="M4 12.5l5 5L20 6.5"/>',
  x:       '<path d="M6 6l12 12M18 6L6 18"/>',
  book:    '<path d="M12 6.5C10.4 5.2 8.4 4.6 6 4.6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1c2.4 0 4.4.6 6 1.9"/><path d="M12 6.5c1.6-1.3 3.6-1.9 6-1.9a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1c-2.4 0-4.4.6-6 1.9z"/><path d="M12 6.5v14"/>',
  note:    '<path d="M6 3.5h9l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/><path d="M8.5 12h7M8.5 16h5"/>',
  pin:     '<path d="M12 17v4.5"/><path d="M9 3.5h6l-.8 5.4 2.8 3.1H7l2.8-3.1z"/>',
  layers:  '<path d="M12 3.5l9 4.8-9 4.8-9-4.8z"/><path d="M3 13l9 4.8 9-4.8"/>',
  flask:   '<path d="M9.5 3.5h5M10.5 3.5v5.6L5.2 18a2 2 0 0 0 1.7 3h10.2a2 2 0 0 0 1.7-3l-5.3-8.9V3.5"/>',
  search:  '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  bulb:    '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
  help:    '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4A2.6 2.6 0 0 1 14.6 10c0 1.7-2.6 2-2.6 3.6"/><path d="M12 17.2v.01"/>',
  cap:     '<path d="M2.5 9L12 4.5 21.5 9 12 13.5z"/><path d="M6 11.5V16c0 1 2.7 3 6 3s6-2 6-3v-4.5"/>',
  trash:   '<path d="M4 7h16M9.5 7V4.5h5V7"/><path d="M6 7l1 13h10l1-13"/>',
  moon:    '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
  download:'<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
  calendar:'<rect x="3.5" y="5" width="17" height="15.5" rx="2.4"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
  alert:   '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.01"/>',
  star:    '<path d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8z"/>',
  undo:    '<path d="M9 7L4.5 11.5 9 16"/><path d="M5 11.5h9a5 5 0 0 1 0 10h-2"/>',
};

/** 글머리에 끼우는 인라인 SVG 문자열. name이 없으면 빈 문자열. */
export function ico(name) {
  const p = P[name];
  if (!p) return '';
  return '<svg class="ic-in" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" '
    + `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
}
