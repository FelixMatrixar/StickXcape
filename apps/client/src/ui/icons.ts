/** Line icons drawn with a brush-like stroke. */
const icon = (body: string, fill = false) =>
  `<svg viewBox="0 0 24 24" width="22" height="22" fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICON = {
  sound: icon('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/>'),
  muted: icon('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5"/>'),
  gear: icon('<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2L5.5 5.5"/>'),
  back: icon('<path d="M15 5l-7 7 7 7"/>'),
  arrow: icon('<path d="M5 12h13M13 6l6 6-6 6"/>'),
  play: icon('<path d="M7 4.8v14.4L19 12z" fill="currentColor"/>'),
  pause: icon('<path d="M8 5v14M16 5v14"/>'),
  close: icon('<path d="M6 6l12 12M18 6L6 18"/>'),
  dice: icon('<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><circle cx="8.5" cy="8.5" r="1.3" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.3" fill="currentColor"/><circle cx="15.5" cy="8.5" r="1.3" fill="currentColor"/><circle cx="8.5" cy="15.5" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/>'),
  camera: icon('<path d="M3.5 8.5a2 2 0 0 1 2-2h2l1.5-2h6l1.5 2h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.6"/>'),
  users: icon('<circle cx="9" cy="8" r="3.4"/><path d="M2.8 20c.6-3.6 3.1-5.6 6.2-5.6s5.6 2 6.2 5.6"/><path d="M16 4.8a3.3 3.3 0 0 1 0 6.4M18 14.6c1.9.7 3 2.6 3.3 5.4"/>'),
  link: icon('<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>'),
  copy: icon('<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>'),
  share: icon('<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>'),
  check: icon('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  record: icon('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4" fill="currentColor"/>'),
  grid: icon('<rect x="3.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.8"/>'),
  bolt: icon('<path d="M13 2.5L5 13.5h6l-1 8 8-11h-6z" fill="currentColor"/>'),
  trophy: icon('<path d="M7.5 4h9v5a4.5 4.5 0 0 1-9 0z"/><path d="M7.5 6H4.5a3 3 0 0 0 3 4M16.5 6h3a3 3 0 0 1-3 4M12 13.5V17M8.5 20.5h7M9.5 17h5"/>'),
  redo: icon('<path d="M20 8a8.5 8.5 0 1 0 1.2 7"/><path d="M20.5 3.5V8.5h-5"/>'),
  edit: icon('<path d="M4 20l1-4.5L16 4.5a2.1 2.1 0 0 1 3 3L8 18.5z"/><path d="M14 6.5l3 3"/>'),
  trash: icon('<path d="M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5l1 13h9l1-13"/>'),
  swap: icon('<path d="M7 7h12l-4-4M17 17H5l4 4"/>'),
  spark: icon('<path d="M12 2.5l2 6.5 6.5 2-6.5 2-2 7-2-7-6.5-2 6.5-2z" fill="currentColor"/>'),
  fist: icon('<path d="M6 10V7.5a1.5 1.5 0 0 1 3 0V10M9 9V6a1.5 1.5 0 0 1 3 0v3M12 9V6.5a1.5 1.5 0 0 1 3 0V10M15 10V8a1.5 1.5 0 0 1 3 0v5.5a6.5 6.5 0 0 1-6.5 6.5h-.5A6 6 0 0 1 6 14v-4a1.5 1.5 0 0 1 3 0"/>'),
  stick: icon('<circle cx="12" cy="4.8" r="2.3" fill="currentColor"/><path d="M12 7.5v7M12 9.5l-4.5 3M12 9.5l5 1.5M12 14.5l-3.5 6M12 14.5l4 6"/>'),
};
