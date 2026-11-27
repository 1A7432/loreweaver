// `loreweaver-protocol`: wire protocol 3.0 for clients — the frames and built-in views, the
// decoder for what a server sends, the client session, the byte channel's lines and the one
// evaluation of panel templates every client shares. Nothing here does I/O.
//
// `loreweaver-protocol/v3` names the same thing: the package's version is the protocol's, and
// a later major will have its own entry beside this one.
export * from "./v3/index.js"
// The condition language of panels (`visible_when`), for tools that author or check them.
export * from "./condexpr.js"
