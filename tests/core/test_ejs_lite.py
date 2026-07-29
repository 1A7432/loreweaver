"""Tests for core.ejs_lite: the fail-safe EJS-subset renderer, macro substitution, and
@@decorator parsing used by the worldbook's SillyTavern template compatibility."""

from __future__ import annotations

from core.ejs_lite import MAX_TEMPLATE_LEN, render, split_decorators, substitute_macros


def _resolver(values: dict):
    return lambda path: values.get(path)


# ---------------------------------------------------------------------------
# Output tags + conditionals
# ---------------------------------------------------------------------------


def test_plain_text_passes_through_unchanged():
    result = render("Just a normal entry — 中文也一样。", _resolver({}))
    assert result.text == "Just a normal entry — 中文也一样。"
    assert result.warnings == []


def test_output_tags_render_values():
    resolve = _resolver({"好感度": 60, "name": "络络"})
    assert render("好感度=<%= getvar('好感度') %>", resolve).text == "好感度=60"
    assert render("<%- name %>!", resolve).text == "络络!"
    assert render("[<%= missing %>]", resolve).text == "[]"  # None renders empty


def test_if_else_chain_selects_one_branch():
    template = "<% if (fear >= 8) { %>PANIC<% } else if (fear >= 4) { %>uneasy<% } else { %>calm<% } %>"
    assert render(template, _resolver({"fear": 9})).text == "PANIC"
    assert render(template, _resolver({"fear": 5})).text == "uneasy"
    assert render(template, _resolver({"fear": 1})).text == "calm"


def test_nested_ifs():
    template = "<% if (a) { %>A<% if (b) { %>B<% } %><% } %>"
    assert render(template, _resolver({"a": 1, "b": 1})).text == "AB"
    assert render(template, _resolver({"a": 1, "b": 0})).text == "A"
    assert render(template, _resolver({"a": 0, "b": 1})).text == ""


def test_broken_condition_takes_no_branch_and_warns():
    result = render("<% if (1 ~ 2) { %>X<% } %>ok", _resolver({}))
    assert result.text == "ok"
    assert result.warnings


def test_broken_output_expression_renders_empty_and_warns():
    result = render("a<%= SafeGetValue(data.x) %>b", _resolver({}))
    assert result.text == "ab"
    assert any("unsupported output" in warning for warning in result.warnings)


def test_comment_tag_is_dropped():
    assert render("x<%# secret note %>y", _resolver({})).text == "xy"


# ---------------------------------------------------------------------------
# Fail-safe behavior
# ---------------------------------------------------------------------------


def test_unbalanced_blocks_strip_tags_but_keep_text():
    result = render("<% if (a) { %>hello", _resolver({"a": 1}))
    assert result.text == "hello"
    assert any("unbalanced" in warning for warning in result.warnings)


def test_stray_close_strips_tags_but_keeps_text():
    result = render("hello<% } %>world", _resolver({}))
    assert result.text == "helloworld"
    assert result.warnings


def test_oversized_template_is_left_verbatim_with_warning():
    big = "x" * (MAX_TEMPLATE_LEN + 1)
    result = render(big, _resolver({}))
    assert result.text == big
    assert any("too long" in warning for warning in result.warnings)


def test_no_raw_tag_syntax_ever_reaches_the_output():
    nasty = "<% if (a) { %>A<% } %><%= b %><% bogus!!! %><% } %>"
    result = render(nasty, _resolver({"a": 1, "b": 2}))
    assert "<%" not in result.text and "%>" not in result.text


# ---------------------------------------------------------------------------
# Statements
# ---------------------------------------------------------------------------


def test_setvar_incvar_decvar_flow_through_the_setter():
    values = {"count": 4}
    writes = []

    def setter(name, value):
        writes.append((name, value))
        values[name] = value

    template = "<% setvar('mood', 'tense'); incvar('count', 2) %><% decvar('count') %>"
    result = render(template, _resolver(values), setter)
    assert result.text == ""
    assert writes == [("mood", "tense"), ("count", 6), ("count", 5)]


def test_statements_without_a_setter_are_noops():
    result = render("<% setvar('x', 1) %>ok", _resolver({}))
    assert result.text == "ok"
    assert result.warnings == []


def test_unsupported_statement_warns_but_renders_rest():
    result = render("<% await getwi('entry') %>ok", _resolver({}))
    assert result.text == "ok"
    assert any("unsupported statement" in warning for warning in result.warnings)


# ---------------------------------------------------------------------------
# Escape block + trim variants
# ---------------------------------------------------------------------------


def test_escape_block_passes_through_unprocessed():
    template = "<#escape-ejs>literal <%% if %%> text<#/escape-ejs>"
    assert render(template, _resolver({})).text == "literal <% if %> text"


def test_dash_close_swallows_following_newline():
    assert render("<%= 'a' -%>\nb", _resolver({})).text == "ab"


# ---------------------------------------------------------------------------
# Macros + decorators
# ---------------------------------------------------------------------------


def test_substitute_macros_getvar_var_user_char():
    resolve = _resolver({"好感度": 60, "fear": 3})
    text = "{{getvar::好感度}}/{{var:fear}} — {{user}} meets {{char}}; {{random:a,b}} stays"
    out = substitute_macros(text, resolve, {"user": "Alice", "char": "络络"})
    assert out == "60/3 — Alice meets 络络; {{random:a,b}} stays"


def test_substitute_macros_without_names_leaves_user_char():
    out = substitute_macros("{{user}}", _resolver({}), None)
    assert out == "{{user}}"


def test_split_decorators_if_and_flags():
    text = "@@if variables.stage === 2\n@@dont_activate\nBody line 1\nBody line 2"
    decorators, body = split_decorators(text)
    assert decorators == {"if": "variables.stage === 2", "dont_activate": True}
    assert body == "Body line 1\nBody line 2"


def test_split_decorators_without_decorators_is_identity():
    text = "email @@handle mid-line is not a decorator\nbody"
    decorators, body = split_decorators(text)
    assert decorators == {}
    assert body == text
