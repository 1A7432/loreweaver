import { expect, test } from "bun:test";

import { isSafeSvg } from "../../../src/infra/media/svg.ts";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const safe = (text: string): boolean => isSafeSvg(enc(text));
const wrap = (body: string, rootAttrs = ""): string => `<svg xmlns="http://www.w3.org/2000/svg"${rootAttrs}>${body}</svg>`;

test("a typical static handout is accepted", () => {
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- a map of the lower hall -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1"
     width="200" height="100%" viewBox="0 0 200 100" role="img" aria-label="Lower hall">
  <title>Lower hall</title>
  <desc>Two rooms &amp; a corridor</desc>
  <g class="walls outer" stroke="#333" stroke-width="2.5" fill="none">
    <rect x="10" y="10" width="80" height="40" rx="3" fill="rgb(10, 20, 30)"><title>Study</title></rect>
    <line x1="90" y1="30" x2="120" y2="30" stroke-dasharray="4 2" stroke-linecap="round"/>
    <polyline points="120,30 150,30 150,60" stroke="currentColor"/>
  </g>
  <text x="50" y="80" font-family="Noto Sans, 'Source Han Sans', 宋体" font-size="12px" font-weight="700"
        text-anchor="middle" dominant-baseline="central" fill="hsl(120deg 50% 40%)">
    Hall &#x4e2d; <tspan id="label-1" fill="#c00">here</tspan>
  </text>
</svg>
`;
  expect(safe(doc)).toBe(true);
  expect(safe('<svg xmlns="http://www.w3.org/2000/svg"/>')).toBe(true);
  // A UTF-8 byte-order mark is not part of the document.
  expect(isSafeSvg(new Uint8Array([0xef, 0xbb, 0xbf, ...enc(wrap("<g/>"))]))).toBe(true);
});

test("scripts, foreign content and every element outside the subset are refused", () => {
  for (const body of [
    "<script>alert(1)</script>",
    '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>',
    "<style>rect{fill:url(http://evil/x)}</style>",
    '<image href="data:image/png;base64,AAAA"/>',
    '<a href="https://evil"><rect/></a>',
    '<use href="#x"/>',
    '<animate attributeName="x"/>',
    '<set attributeName="fill" to="red"/>',
    "<path d=\"M0 0\"/>",
    "<Rect/>",
    "<svg:rect/>",
  ]) {
    expect(safe(wrap(body))).toBe(false);
  }
});

test("event handlers, links, inline CSS and URL-bearing values are refused", () => {
  for (const attrs of [
    ' onload="alert(1)"',
    ' ONLOAD="alert(1)"',
    ' href="https://evil"',
    ' xlink:href="javascript:alert(1)"',
    ' style="fill:red"',
    ' fill="url(#grad)"',
    ' fill="url (#grad)"',
    ' stroke="javascript:alert(1)"',
    ' aria-label="see data:text/html,x"',
    ' aria-label="javascript:x"',
    ' font-family="url(x)"',
    ' font-family="a:b"',
    ' transform="rotate(10)"',
    ' class="a;b"',
    ' x="1e3e3"',
    ' points="1,2,3"',
    ' viewBox="0 0 1"',
  ]) {
    expect(safe(wrap(`<rect${attrs}/>`))).toBe(false);
  }
  // Root declarations accept their one value, and only on the root.
  expect(safe('<svg xmlns="http://evil/ns"/>')).toBe(false);
  expect(safe('<svg xmlns:xlink="http://evil"/>')).toBe(false);
  expect(safe(wrap('<g xmlns="http://www.w3.org/2000/svg"/>'))).toBe(false);
  expect(safe('<svg xmlns:ev="http://www.w3.org/2001/xml-events"/>')).toBe(false);
});

test("DOCTYPE, entities, CDATA and processing instructions are refused", () => {
  expect(safe('<!DOCTYPE svg [<!ENTITY x "y">]>' + wrap("<text>&x;</text>"))).toBe(false);
  expect(safe(wrap("<text>&x;</text>"))).toBe(false);
  expect(safe(wrap("<text>&amp</text>"))).toBe(false);
  expect(safe(wrap("<text><![CDATA[x]]></text>"))).toBe(false);
  expect(safe('<?xml-stylesheet href="x.css"?>' + wrap(""))).toBe(false);
  expect(safe(wrap("<?pi x?>"))).toBe(false);
  expect(safe(`<?xml version="1.0" encoding="UTF-16"?>${wrap("")}`)).toBe(false);
  expect(safe(`  <?xml version="1.0"?>${wrap("")}`)).toBe(false);
  // Character references must resolve to allowed characters.
  expect(safe(wrap("<text>&#0;</text>"))).toBe(false);
  expect(safe(wrap("<text>&#x1b;</text>"))).toBe(false);
  expect(safe(wrap("<text>&#xD800;</text>"))).toBe(false);
  expect(safe(wrap('<rect aria-label="&#x6a;avascript:x"/>'))).toBe(false);
});

test("malformed markup and structure outside the subset are refused", () => {
  for (const doc of [
    "",
    "   ",
    "<g/>",
    "<svg>",
    wrap("<g>"),
    wrap("<g></rect>"),
    wrap("") + "<svg/>",
    wrap("") + "trailing",
    "text" + wrap(""),
    wrap('<rect x="1"y="2"/>'),
    wrap('<rect x="1" x="2"/>'),
    wrap("<rect x=1/>"),
    wrap('<rect x="<1"/>'),
    wrap("<rect>words</rect>"),
    wrap("loose words"),
    wrap("<g><text>x</text></g><tspan/>"),
    wrap("<title><g/></title>"),
    wrap("<!-- a -- b -->"),
    wrap("<text>]]></text>"),
    wrap("<text>a\u0001b</text>"),
    wrap("<text>‮</text>").replace("‮", "\u0085"),
  ]) {
    expect(safe(doc)).toBe(false);
  }
  expect(isSafeSvg(new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0xff, 0x3e]))).toBe(false);
});

test("size, element count and depth are bounded", () => {
  expect(safe(wrap("<g/>".repeat(799)))).toBe(true);
  expect(safe(wrap("<g/>".repeat(800)))).toBe(false);
  expect(safe(wrap("<g>".repeat(31) + "</g>".repeat(31)))).toBe(true);
  expect(safe(wrap("<g>".repeat(32) + "</g>".repeat(32)))).toBe(false);
  expect(safe(wrap(`<!--${"x".repeat(200_001)}-->`))).toBe(false);
});
