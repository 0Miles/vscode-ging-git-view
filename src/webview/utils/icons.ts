/**
 * Inline SVG icons for the webview, all drawn on a uniform 16x16 grid.
 *
 * Everything except the hand-drawn section at the bottom is Octicons v19
 * (MIT, (c) GitHub Inc. — see the third-party notices in LICENSE). They
 * replaced the Octicons v2/v3-era glyphs this project inherited, whose
 * viewBoxes were 10x16 / 12x16 / 14x16 and so rendered at inconsistent widths
 * once placed in a fixed-width slot such as the context menu's icon gutter.
 *
 * Two rules when adding to this file:
 *
 *  - Octicons v19 paths rely on the default `nonzero` fill rule. Do NOT add
 *    `fill-rule="evenodd"` to them — it hollows out the compound shapes.
 *  - Keep the explicit width/height. Some consumers (`#loadingHeader`,
 *    `#dialog svg`) size the icon from the attribute rather than from CSS, so
 *    an attribute-less <svg> would stretch to fill its container.
 */

const svg = (body: string, size = 16, className?: string) =>
  '<svg xmlns="http://www.w3.org/2000/svg" width="' +
  size +
  '" height="' +
  size +
  '" viewBox="0 0 16 16"' +
  (className === undefined ? "" : ' class="' + className + '"') +
  ">" +
  body +
  "</svg>";

/* Octicons v19 — the path data is verbatim from @primer/octicons build/svg. */
const OCTICON = {
  alert:
    '<path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/>',
  arrowSwitch:
    '<path d="M5.22 14.78a.75.75 0 0 0 1.06-1.06L4.56 12h8.69a.75.75 0 0 0 0-1.5H4.56l1.72-1.72a.75.75 0 0 0-1.06-1.06l-3 3a.75.75 0 0 0 0 1.06l3 3Zm5.56-6.5a.75.75 0 1 1-1.06-1.06l1.72-1.72H2.75a.75.75 0 0 1 0-1.5h8.69L9.72 2.28a.75.75 0 0 1 1.06-1.06l3 3a.75.75 0 0 1 0 1.06l-3 3Z"/>',
  check:
    '<path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/>',
  copy: '<path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/>',
  download:
    '<path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z"/><path d="M7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06l1.97 1.969Z"/>',
  eye: '<path d="M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.898a1.62 1.62 0 0 1 0-1.798c.45-.677 1.367-1.931 2.637-3.022C4.33 2.992 6.019 2 8 2ZM1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.825.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z"/>',
  file: '<path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"/>',
  fileDiff:
    '<path d="M1 1.75C1 .784 1.784 0 2.75 0h7.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16H2.75A1.75 1.75 0 0 1 1 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V4.664a.25.25 0 0 0-.073-.177l-2.914-2.914a.25.25 0 0 0-.177-.073ZM8 3.25a.75.75 0 0 1 .75.75v1.5h1.5a.75.75 0 0 1 0 1.5h-1.5v1.5a.75.75 0 0 1-1.5 0V7h-1.5a.75.75 0 0 1 0-1.5h1.5V4A.75.75 0 0 1 8 3.25Zm-3 8a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1-.75-.75Z"/>',
  folderClosed:
    '<path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"/>',
  folderOpen:
    '<path d="M.513 1.513A1.75 1.75 0 0 1 1.75 1h3.5c.55 0 1.07.26 1.4.7l.9 1.2a.25.25 0 0 0 .2.1H13a1 1 0 0 1 1 1v.5H2.75a.75.75 0 0 0 0 1.5h11.978a1 1 0 0 1 .994 1.117L15 13.25A1.75 1.75 0 0 1 13.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75c0-.464.184-.91.513-1.237Z"/>',
  gitBranch:
    '<path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/>',
  gitCompare:
    '<path d="M9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM6 12v-1.646a.25.25 0 0 1 .427-.177l2.396 2.396a.25.25 0 0 1 0 .354l-2.396 2.396A.25.25 0 0 1 6 15.146V13.5H5A2.5 2.5 0 0 1 2.5 11V5.372a2.25 2.25 0 1 1 1.5 0V11a1 1 0 0 0 1 1ZM4 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0ZM12.75 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/>',
  gitMerge:
    '<path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z"/>',
  gitPullRequest:
    '<path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/>',
  history:
    '<path d="m.427 1.927 1.215 1.215a8.002 8.002 0 1 1-1.6 5.685.75.75 0 1 1 1.493-.154 6.5 6.5 0 1 0 1.18-4.458l1.358 1.358A.25.25 0 0 1 3.896 6H.25A.25.25 0 0 1 0 5.75V2.104a.25.25 0 0 1 .427-.177ZM7.75 4a.75.75 0 0 1 .75.75v2.992l2.028.812a.75.75 0 0 1-.557 1.392l-2.5-1A.751.751 0 0 1 7 8.25v-3.5A.75.75 0 0 1 7.75 4Z"/>',
  issue:
    '<path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/>',
  linkExternal:
    '<path d="M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z"/>',
  moveToEnd:
    '<path d="m10.78 8.53-3.75 3.75a.749.749 0 1 1-1.06-1.06l2.469-2.47H1.75a.75.75 0 0 1 0-1.5h6.689L5.97 4.78a.749.749 0 1 1 1.06-1.06l3.75 3.75a.749.749 0 0 1 0 1.06ZM13 12.25v-8.5a.75.75 0 0 1 1.5 0v8.5a.75.75 0 0 1-1.5 0Z"/>',
  pencil:
    '<path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z"/>',
  repoPull:
    '<path d="M1 2.5A2.5 2.5 0 0 1 3.5 0h8.75a.75.75 0 0 1 .75.75V6a.75.75 0 0 1-1.5 0V1.5h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 3.5 9h3a.75.75 0 0 1 0 1.5h-3a1 1 0 0 0 0 2h3a.75.75 0 0 1 0 1.5h-3A2.5 2.5 0 0 1 1 11.5v-9Z"/><path d="M12.21 13.479a.75.75 0 1 0 1.061 1.061l2.504-2.505a.75.75 0 0 0 0-1.061L13.271 8.47a.75.75 0 0 0-1.061 1.06l1.224 1.225H8.75a.75.75 0 1 0 0 1.5h4.685l-1.225 1.224Z"/>',
  repoPush:
    '<path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0V1.5h-8a1 1 0 0 0-1 1v6.708A2.493 2.493 0 0 1 4.5 9h2.25a.75.75 0 0 1 0 1.5H4.5a1 1 0 0 0 0 2h4.75a.75.75 0 0 1 0 1.5H4.5A2.5 2.5 0 0 1 2 11.5Zm12.23 7.79h-.001l-1.224-1.224v6.184a.75.75 0 0 1-1.5 0V9.066L10.28 10.29a.75.75 0 0 1-1.06-1.061l2.505-2.504a.75.75 0 0 1 1.06 0L15.29 9.23a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018Z"/>',
  search:
    '<path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"/>',
  sync: '<path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z"/>',
  tag: '<path d="M1 7.775V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 0 1 0 2.474l-5.026 5.026a1.75 1.75 0 0 1-2.474 0l-6.25-6.25A1.752 1.752 0 0 1 1 7.775Zm1.5 0c0 .066.026.13.073.177l6.25 6.25a.25.25 0 0 0 .354 0l5.025-5.025a.25.25 0 0 0 0-.354l-6.25-6.25a.25.25 0 0 0-.177-.073H2.75a.25.25 0 0 0-.25.25ZM6 5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"/>',
  terminal:
    '<path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25Zm1.75-.25a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25ZM7.25 8a.749.749 0 0 1-.22.53l-2.25 2.25a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734L5.44 8 3.72 6.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.25 2.25c.141.14.22.331.22.53Zm1.5 1.5h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1 0-1.5Z"/>',
  trash:
    '<path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z"/>',
  undo: '<path d="M1.22 6.28a.749.749 0 0 1 0-1.06l3.5-3.5a.749.749 0 1 1 1.06 1.06L3.561 5h7.188l.001.007L10.749 5c.058 0 .116.007.171.019A4.501 4.501 0 0 1 10.5 14H8.796a.75.75 0 0 1 0-1.5H10.5a3 3 0 1 0 0-6H3.561L5.78 8.72a.749.749 0 1 1-1.06 1.06l-3.5-3.5Z"/>',
  x: '<path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/>'
};

/* Hand-drawn, on the same 16x16 grid.
 *
 * `cherryPick` and `rebase` exist because neither Octicons nor Codicons ships
 * a glyph for either operation, and both are core actions here. They borrow
 * the Octicons git grammar — a vertical bar is a branch, a filled circle is a
 * commit — so they read as members of that family: cherry-pick moves one
 * commit across, rebase moves a run of them.
 *
 * The rest predate the Octicons v19 sweep and have no upstream equivalent. */
const DRAWN = {
  cherryPick:
    '<rect x="2" y="1" width="1.5" height="14" rx=".75"/><rect x="12.5" y="1" width="1.5" height="14" rx=".75"/><circle cx="2.75" cy="8" r="1.9"/><circle cx="13.25" cy="8" r="1.9"/><path d="M5.5 7.25H8.1V5.85L10.5 8 8.1 10.15V8.75H5.5Z"/>',
  rebase:
    '<rect x="2" y="1" width="1.5" height="14" rx=".75"/><rect x="12.5" y="1" width="1.5" height="14" rx=".75"/><circle cx="2.75" cy="3.4" r="1.5"/><circle cx="2.75" cy="8" r="1.5"/><circle cx="2.75" cy="12.6" r="1.5"/><circle cx="13.25" cy="8" r="1.9"/><path d="M5.5 7.25H8.1V5.85L10.5 8 8.1 10.15V8.75H5.5Z"/>',
  stash:
    '<path fill-rule="evenodd" d="M1 3h14a1 1 0 0 1 1 1v3H0V4a1 1 0 0 1 1-1zm-1 5h5a2 2 0 0 0 6 0h5v5a1 1 0 0 1-1 1H1a1 1 0 0 1-1-1V8z"/>',
  // The Commit Details View file-layout toggle: a root row with two indented
  // child rows (tree), and three flat rows (list).
  fileTreeView:
    '<path fill-rule="evenodd" d="M1 2h2v2H1V2zm4 0h10v2H5V2zM2 4h1v8H2V4zm1 3h3v1H3V7zm0 4h3v1H3v-1zm3-5h2v2H6V6zm4 0h5v2h-5V6zm-4 4h2v2H6v-2zm4 0h5v2h-5v-2z"/>',
  fileListView:
    '<path fill-rule="evenodd" d="M1 3h2v2H1V3zm4 0h10v2H5V3zM1 7h2v2H1V7zm4 0h10v2H5V7zM1 11h2v2H1v-2zm4 0h10v2H5v-2z"/>',
  // Funnel for the toolbar's branch-filter chip. Deliberately not the "search"
  // magnifier: this marks a standing state, not an action you can invoke.
  filter: '<path fill-rule="evenodd" d="M1 2h14l-5.5 6.5v5l-3-1.5V8.5z"/>',
  // Crosshair/target for the "Locate HEAD" control.
  locate:
    '<path fill-rule="evenodd" d="M9 1a1 1 0 0 0-2 0v1.06A6 6 0 0 0 2.06 7H1a1 1 0 0 0 0 2h1.06A6 6 0 0 0 7 13.94V15a1 1 0 1 0 2 0v-1.06A6 6 0 0 0 13.94 9H15a1 1 0 1 0 0-2h-1.06A6 6 0 0 0 9 2.06V1zM8 3.7a4.3 4.3 0 1 1 0 8.6 4.3 4.3 0 0 1 0-8.6zM8 5.5A2.5 2.5 0 1 0 8 10.5a2.5 2.5 0 0 0 0-5z"/>'
};

export const svgIcons = {
  /* Graph and reference labels */
  alert: svg(OCTICON.alert),
  branch: svg(OCTICON.gitBranch),
  tag: svg(OCTICON.tag),
  stash: svg(DRAWN.stash),
  /* Loading indicators. 24px because `#loadingHeader` has no CSS size of its
     own and reads the width/height attributes. */
  loading: svg(OCTICON.sync, 24),

  /* Control bar */
  search: svg(OCTICON.search),
  terminal: svg(OCTICON.terminal),
  locate: svg(DRAWN.locate),
  download: svg(OCTICON.download),
  refresh: svg(OCTICON.sync),
  /* 11px: the branch-filter chip is smaller than a toolbar button. */
  filter: svg(DRAWN.filter, 11),

  /* Commit Details View */
  close: svg(OCTICON.x),
  fileTreeView: svg(DRAWN.fileTreeView),
  fileListView: svg(DRAWN.fileListView),
  openFolder: svg(OCTICON.folderOpen, 16, "openFolderIcon"),
  closedFolder: svg(OCTICON.folderClosed, 16, "closedFolderIcon"),
  file: svg(OCTICON.file, 16, "fileIcon"),
  copy: svg(OCTICON.copy),
  openFile: svg(OCTICON.linkExternal),
  viewRevision: svg(OCTICON.eye),
  compare: svg(OCTICON.gitCompare),

  /* Context menu only */
  check: svg(OCTICON.check),
  arrowSwitch: svg(OCTICON.arrowSwitch),
  cherryPick: svg(DRAWN.cherryPick),
  fileDiff: svg(OCTICON.fileDiff),
  gitMerge: svg(OCTICON.gitMerge),
  gitPullRequest: svg(OCTICON.gitPullRequest),
  history: svg(OCTICON.history),
  issue: svg(OCTICON.issue),
  moveToEnd: svg(OCTICON.moveToEnd),
  pencil: svg(OCTICON.pencil),
  rebase: svg(DRAWN.rebase),
  repoPull: svg(OCTICON.repoPull),
  repoPush: svg(OCTICON.repoPush),
  trash: svg(OCTICON.trash),
  undo: svg(OCTICON.undo)
};

/** The name of an icon that a context menu item can display in its gutter. */
export type SvgIconName = keyof typeof svgIcons;
