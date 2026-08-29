/**
 * Inline markdown rendering for AI message text.
 *
 * LLM replies commonly carry inline emphasis (`**bold**`, `*italic*`,
 * `***bold italic***`, `` `code` ``, `~~strikethrough~~`) that would
 * otherwise surface as literal asterisks in the chat bubbles. This module
 * parses that small CommonMark-inspired inline subset and renders it with
 * nested React Native <Text> components — no third-party markdown
 * dependency, no block-level constructs (headings, lists, fences), which
 * keeps chat bubbles predictable.
 *
 * The parser is deliberately conservative so partially streamed content
 * degrades gracefully: an emphasis run without a valid closer on the same
 * line renders as literal text and becomes formatted once its closer
 * arrives. Flanking rules keep ordinary prose intact — arithmetic like
 * `2 * 3 * 4`, `snake_case_identifiers` and stray asterisks never turn
 * into formatting.
 */
import React, {useMemo} from 'react';
import type {ReactNode} from 'react';
import {Platform, Text} from 'react-native';
import type {StyleProp, TextStyle} from 'react-native';

import type {ThemeColors} from '../theme/colors';

export type InlineNode =
  | {kind: 'text'; text: string}
  | {kind: 'code'; text: string}
  | {kind: 'bold'; children: InlineNode[]}
  | {kind: 'italic'; children: InlineNode[]}
  | {kind: 'boldItalic'; children: InlineNode[]}
  | {kind: 'strike'; children: InlineNode[]};

/** Opener candidates, longest first so `***` wins over `**` and `*`. */
const OPENERS = ['***', '**', '~~', '__', '`', '*', '_'];

/** Nesting guard for pathological input such as `*a*a*a*a*…`. */
const MAX_DEPTH = 8;

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char);
}

function isAlphanumeric(char: string | undefined): boolean {
  return char !== undefined && /[a-zA-Z0-9]/.test(char);
}

interface OpenerMatch {
  marker: string;
  index: number;
}

/**
 * A `*`/`_`/`~` marker must constitute its whole delimiter run: no
 * identical character immediately before or after it. This keeps longer
 * runs (for example the `**` inside `hello ** world **`) from being
 * reinterpreted as single-character emphasis.
 */
function isExactDelimiterRun(line: string, index: number, marker: string): boolean {
  const runChar = marker[0];
  return line[index - 1] !== runChar && line[index + marker.length] !== runChar;
}

/**
 * Validates an opener at a known position: formatting content must be
 * non-empty and must not begin with whitespace; underscore emphasis is
 * additionally rejected inside words (`snake_case`) the way CommonMark
 * treats intraword underscores.
 */
function isValidOpener(line: string, marker: string, index: number): boolean {
  const contentStart = index + marker.length;
  const after = line[contentStart];
  if (after === undefined) {
    return false;
  }
  if (marker !== '`' && isWhitespace(after)) {
    return false;
  }
  if (marker !== '`' && !isExactDelimiterRun(line, index, marker)) {
    return false;
  }
  if (marker === '_' || marker === '__') {
    if (isAlphanumeric(line[index - 1])) {
      return false;
    }
  }
  return true;
}

function findOpener(line: string, from: number): OpenerMatch | null {
  for (let index = from; index < line.length; index += 1) {
    for (const marker of OPENERS) {
      if (line.startsWith(marker, index) && isValidOpener(line, marker, index)) {
        return {marker, index};
      }
    }
  }
  return null;
}

/**
 * Locates the first valid closer for the opener match. Closers must leave
 * non-empty content and must not be preceded by whitespace; underscores
 * additionally may not close intraword. Emphasis never spans lines
 * because parsing is line-bounded.
 */
function findCloser(line: string, opener: OpenerMatch): number {
  const {marker, index} = opener;
  const contentStart = index + marker.length;
  for (let at = contentStart; at <= line.length - marker.length; at += 1) {
    if (!line.startsWith(marker, at)) {
      continue;
    }
    if (at === contentStart) {
      continue;
    }
    if (marker !== '`') {
      if (!isExactDelimiterRun(line, at, marker) || isWhitespace(line[at - 1])) {
        continue;
      }
    }
    if (marker === '_' || marker === '__') {
      if (isAlphanumeric(line[at + marker.length])) {
        continue;
      }
    }
    return at;
  }
  return -1;
}

function parseLine(line: string, depth: number): InlineNode[] {
  const nodes: InlineNode[] = [];
  let plain = '';
  let at = 0;
  while (at < line.length) {
    const opener = findOpener(line, at);
    if (!opener) {
      plain += line.slice(at);
      break;
    }
    if (opener.index > at) {
      plain += line.slice(at, opener.index);
    }
    const closeAt = depth >= MAX_DEPTH ? -1 : findCloser(line, opener);
    if (closeAt === -1) {
      plain += line.slice(opener.index, opener.index + opener.marker.length);
      at = opener.index + opener.marker.length;
      continue;
    }
    if (plain) {
      nodes.push({kind: 'text', text: plain});
      plain = '';
    }
    const inner = line.slice(opener.index + opener.marker.length, closeAt);
    switch (opener.marker) {
      case '***':
        nodes.push({kind: 'boldItalic', children: parseLine(inner, depth + 1)});
        break;
      case '**':
      case '__':
        nodes.push({kind: 'bold', children: parseLine(inner, depth + 1)});
        break;
      case '*':
      case '_':
        nodes.push({kind: 'italic', children: parseLine(inner, depth + 1)});
        break;
      case '~~':
        nodes.push({kind: 'strike', children: parseLine(inner, depth + 1)});
        break;
      default:
        nodes.push({kind: 'code', text: inner});
        break;
    }
    at = closeAt + opener.marker.length;
  }
  if (plain) {
    nodes.push({kind: 'text', text: plain});
  }
  return nodes;
}

/**
 * Parses message content into inline nodes. Newlines are preserved as
 * text nodes; no inline marker crosses a line boundary.
 */
export function parseInlineMarkdown(input: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  input.split('\n').forEach((line, index) => {
    if (index > 0) {
      nodes.push({kind: 'text', text: '\n'});
    }
    nodes.push(...parseLine(line, 0));
  });
  return nodes;
}

const BOLD_STYLE: TextStyle = {fontWeight: '700'};
const ITALIC_STYLE: TextStyle = {fontStyle: 'italic'};
const BOLD_ITALIC_STYLE: TextStyle = {fontWeight: '700', fontStyle: 'italic'};
const STRIKE_STYLE: TextStyle = {textDecorationLine: 'line-through'};

/** Monospace styling for inline code, derived from the active theme. */
export function createCodeStyle(c: ThemeColors): TextStyle {
  return {
    fontFamily: Platform.select({ios: 'Menlo', android: 'monospace', default: 'monospace'}),
    fontSize: 14,
    color: c.textPrimary,
    backgroundColor: c.border,
  };
}

function renderNode(node: InlineNode, index: number, codeStyle?: StyleProp<TextStyle>): ReactNode {
  switch (node.kind) {
    case 'text':
      return node.text;
    case 'code':
      return (
        <Text key={`md-${index}`} style={codeStyle}>
          {node.text}
        </Text>
      );
    case 'bold':
      return (
        <Text key={`md-${index}`} style={BOLD_STYLE}>
          {renderChildren(node.children, codeStyle)}
        </Text>
      );
    case 'italic':
      return (
        <Text key={`md-${index}`} style={ITALIC_STYLE}>
          {renderChildren(node.children, codeStyle)}
        </Text>
      );
    case 'boldItalic':
      return (
        <Text key={`md-${index}`} style={BOLD_ITALIC_STYLE}>
          {renderChildren(node.children, codeStyle)}
        </Text>
      );
    case 'strike':
      return (
        <Text key={`md-${index}`} style={STRIKE_STYLE}>
          {renderChildren(node.children, codeStyle)}
        </Text>
      );
  }
}

function renderChildren(nodes: InlineNode[], codeStyle?: StyleProp<TextStyle>): ReactNode[] {
  return nodes.map((node, index) => renderNode(node, index, codeStyle));
}

export interface MarkdownTextProps {
  /** Raw message content; formatting markers are parsed, not stored. */
  content: string;
  /** Bubble text style; nested formatting inherits color and size from it. */
  style?: StyleProp<TextStyle>;
  /** Style applied to `code` spans (see {@link createCodeStyle}). */
  codeStyle?: StyleProp<TextStyle>;
}

/**
 * A read-only <Text> that renders the inline markdown subset carried by
 * AI messages. A pure function of `content`, so it fits the memoized
 * message-row contract: parsing is memoized per content string and
 * streaming flushes simply re-parse the growing text.
 */
export function MarkdownText({content, style, codeStyle}: MarkdownTextProps) {
  const nodes = useMemo(() => parseInlineMarkdown(content), [content]);
  return <Text style={style}>{renderChildren(nodes, codeStyle)}</Text>;
}
