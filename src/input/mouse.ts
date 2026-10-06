import type { CommandSender } from './keyboard.ts';

/**
 * A left click at viewport coordinates, as three trusted input events:
 * move (so hover state is correct), press, release.
 */
export async function clickAt(sender: CommandSender, x: number, y: number): Promise<void> {
  await sender.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sender.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await sender.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}
