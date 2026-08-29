/**
 * Inline markdown rendering for AI messages: parser unit tests plus
 * component render tests covering the formatting surface (TASK-121).
 */
import React from 'react';
import {render, screen} from '@testing-library/react-native';

import {
  MarkdownText,
  createCodeStyle,
  parseInlineMarkdown,
} from '../src/screens/MarkdownText';
import {darkColors} from '../src/theme/colors';

function flattenStyle(style: unknown): Record<string, unknown> {
  const entries = Array.isArray(style) ? style : [style];
  return Object.assign(
    {},
    ...entries.filter(Boolean).map(s => (typeof s === 'object' ? s : {})),
  );
}

describe('parseInlineMarkdown', () => {
  it('keeps plain prose as a single text node', () => {
    expect(parseInlineMarkdown('Hello there!')).toEqual([
      {kind: 'text', text: 'Hello there!'},
    ]);
  });

  it('returns no nodes for empty content', () => {
    expect(parseInlineMarkdown('')).toEqual([]);
  });

  it('parses double-asterisk bold', () => {
    expect(parseInlineMarkdown('Say **hi** now')).toEqual([
      {kind: 'text', text: 'Say '},
      {kind: 'bold', children: [{kind: 'text', text: 'hi'}]},
      {kind: 'text', text: ' now'},
    ]);
  });

  it('parses single-asterisk italic', () => {
    expect(parseInlineMarkdown('Say *hi* now')).toEqual([
      {kind: 'text', text: 'Say '},
      {kind: 'italic', children: [{kind: 'text', text: 'hi'}]},
      {kind: 'text', text: ' now'},
    ]);
  });

  it('parses triple-asterisk bold italic', () => {
    expect(parseInlineMarkdown('***wow***')).toEqual([
      {kind: 'boldItalic', children: [{kind: 'text', text: 'wow'}]},
    ]);
  });

  it('parses underscore bold and italic', () => {
    expect(parseInlineMarkdown('__b__ and _i_')).toEqual([
      {kind: 'bold', children: [{kind: 'text', text: 'b'}]},
      {kind: 'text', text: ' and '},
      {kind: 'italic', children: [{kind: 'text', text: 'i'}]},
    ]);
  });

  it('parses strikethrough', () => {
    expect(parseInlineMarkdown('was ~~wrong~~')).toEqual([
      {kind: 'text', text: 'was '},
      {kind: 'strike', children: [{kind: 'text', text: 'wrong'}]},
    ]);
  });

  it('parses inline code literally', () => {
    expect(parseInlineMarkdown('run `npm install` now')).toEqual([
      {kind: 'text', text: 'run '},
      {kind: 'code', text: 'npm install'},
      {kind: 'text', text: ' now'},
    ]);
  });

  it('parses bold and italic side by side', () => {
    expect(parseInlineMarkdown('**bold** and *italic*')).toEqual([
      {kind: 'bold', children: [{kind: 'text', text: 'bold'}]},
      {kind: 'text', text: ' and '},
      {kind: 'italic', children: [{kind: 'text', text: 'italic'}]},
    ]);
  });

  it('parses nested emphasis inside bold', () => {
    expect(parseInlineMarkdown('**bold *inner* tail**')).toEqual([
      {
        kind: 'bold',
        children: [
          {kind: 'text', text: 'bold '},
          {kind: 'italic', children: [{kind: 'text', text: 'inner'}]},
          {kind: 'text', text: ' tail'},
        ],
      },
    ]);
  });

  it('allows intraword asterisk emphasis', () => {
    expect(parseInlineMarkdown('a*b*c')).toEqual([
      {kind: 'text', text: 'a'},
      {kind: 'italic', children: [{kind: 'text', text: 'b'}]},
      {kind: 'text', text: 'c'},
    ]);
  });

  it('leaves unclosed markers as literal text (streaming safety)', () => {
    expect(parseInlineMarkdown('unclosed **bold')).toEqual([
      {kind: 'text', text: 'unclosed **bold'},
    ]);
    expect(parseInlineMarkdown('unclosed *ital')).toEqual([
      {kind: 'text', text: 'unclosed *ital'},
    ]);
  });

  it('never formats empty emphasis runs', () => {
    expect(parseInlineMarkdown('a **** b')).toEqual([{kind: 'text', text: 'a **** b'}]);
  });

  it('leaves arithmetic asterisks alone', () => {
    expect(parseInlineMarkdown('2 * 3 * 4 = 24')).toEqual([
      {kind: 'text', text: '2 * 3 * 4 = 24'},
    ]);
  });

  it('leaves intraword underscores alone', () => {
    expect(parseInlineMarkdown('read snake_case_name here')).toEqual([
      {kind: 'text', text: 'read snake_case_name here'},
    ]);
  });

  it('does not format runs separated from content by spaces', () => {
    expect(parseInlineMarkdown('hello ** world ** again')).toEqual([
      {kind: 'text', text: 'hello ** world ** again'},
    ]);
  });

  it('keeps emphasis from crossing a line break', () => {
    expect(parseInlineMarkdown('*a\nb*')).toEqual([
      {kind: 'text', text: '*a'},
      {kind: 'text', text: '\n'},
      {kind: 'text', text: 'b*'},
    ]);
  });

  it('preserves newlines between formatted segments', () => {
    expect(parseInlineMarkdown('one\n**two**\nthree')).toEqual([
      {kind: 'text', text: 'one'},
      {kind: 'text', text: '\n'},
      {kind: 'bold', children: [{kind: 'text', text: 'two'}]},
      {kind: 'text', text: '\n'},
      {kind: 'text', text: 'three'},
    ]);
  });

  it('leaves degenerate trailing runs as literal text', () => {
    // `**bold***` — the closing run has three stars, which cannot close
    // a `**` opener, so the whole run stays literal instead of guessing.
    expect(parseInlineMarkdown('**bold***')).toEqual([
      {kind: 'text', text: '**bold***'},
    ]);
  });
});

describe('MarkdownText component', () => {
  it('renders plain content as one text node', async () => {
    await render(<MarkdownText content="Hello!" style={{fontSize: 15}} />);
    expect(screen.getByText('Hello!')).toBeOnTheScreen();
  });

  it('renders bold segments without the literal markers', async () => {
    await render(<MarkdownText content="This is **key** info" style={{fontSize: 15}} />);

    expect(screen.getByText('This is key info')).toBeOnTheScreen();

    const bold = screen.getByText('key');
    expect(flattenStyle(bold.props.style)).toMatchObject({fontWeight: '700'});
  });

  it('renders italic segments', async () => {
    await render(<MarkdownText content="Say *please*" style={{fontSize: 15}} />);
    expect(flattenStyle(screen.getByText('please').props.style)).toMatchObject({
      fontStyle: 'italic',
    });
  });

  it('renders bold italic segments', async () => {
    await render(<MarkdownText content="***wow***" style={{fontSize: 15}} />);
    expect(flattenStyle(screen.getByText('wow').props.style)).toMatchObject({
      fontWeight: '700',
      fontStyle: 'italic',
    });
  });

  it('renders strikethrough segments', async () => {
    await render(<MarkdownText content="was ~~wrong~~" style={{fontSize: 15}} />);
    expect(flattenStyle(screen.getByText('wrong').props.style)).toMatchObject({
      textDecorationLine: 'line-through',
    });
  });

  it('applies the code style to code spans', async () => {
    const codeStyle = createCodeStyle(darkColors);
    await render(
      <MarkdownText
        content="run `npm install` now"
        style={{fontSize: 15}}
        codeStyle={codeStyle}
      />,
    );
    const code = screen.getByText('npm install');
    expect(flattenStyle(code.props.style)).toMatchObject(codeStyle);
  });

  it('renders multiline content with per-line formatting', async () => {
    await render(
      <MarkdownText content={'Line one\n**Line two**'} style={{fontSize: 15}} />,
    );
    // The newline survives rendering; RNTL collapses it while matching.
    expect(screen.getByText('Line one\nLine two')).toBeOnTheScreen();
    const bold = screen.getByText('Line two');
    expect(flattenStyle(bold.props.style)).toMatchObject({fontWeight: '700'});
  });

  it('renders unparseable markers as literal text', async () => {
    await render(<MarkdownText content="unclosed **bold" style={{fontSize: 15}} />);
    expect(screen.getByText('unclosed **bold')).toBeOnTheScreen();
  });
});
