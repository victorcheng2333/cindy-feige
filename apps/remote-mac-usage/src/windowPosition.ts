interface Rect { x: number; y: number; width: number; height: number }

/** Electron's native setPosition accepts integer DIP coordinates, including on Retina. */
export function trayWindowPosition(tray: Rect, workArea: Rect, size: [number, number]): [number, number] {
  const [width, height] = size;
  return [
    Math.round(Math.max(workArea.x, Math.min(tray.x + tray.width / 2 - width / 2, workArea.x + workArea.width - width))),
    Math.round(Math.max(workArea.y, Math.min(tray.y + tray.height + 8, workArea.y + workArea.height - height))),
  ];
}
