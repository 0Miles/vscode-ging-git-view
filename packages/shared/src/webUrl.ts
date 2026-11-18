/** The WHATWG URL parser: a global in the browser and in Node alike, which
 *  this package's libraries — neither DOM nor Node — do not name. */
declare const URL: new (input: string) => { protocol: string; href: string };

/** `target` as a web address — `http:` or `https:` — in the normalized form
 *  the URL parser gives it, or `null` when it is no web address. What the
 *  desktop settings page renders as a link out of the app, and what the app
 *  hands the browser: the one test for both, so a link the page draws is one
 *  the window lets out (#397), and the browser is given the address as parsed,
 *  not the text that was checked (#391). */
export function webUrl(target: string): string | null {
  let url: { protocol: string; href: string };
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
}

/** Whether `target` is a web address; see `webUrl`. */
export function isWebUrl(target: string): boolean {
  return webUrl(target) !== null;
}
