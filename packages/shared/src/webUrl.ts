/** Whether `target` is a web address, `http:` or `https:`: what the desktop
 *  settings page renders as a link out of the app, and what its window then
 *  hands the browser — the one test for both, so a link the page draws is
 *  one the window lets out (#397). */
export function isWebUrl(target: string): boolean {
  return /^https?:\/\//i.test(target);
}
