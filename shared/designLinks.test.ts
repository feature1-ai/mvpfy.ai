import { describe, expect, it } from 'vitest';
import { designLinksBlock, isClaudeDesignLink, splitDesignLinks } from './designLinks';

const DESIGN = 'https://claude.ai/design/p/0f3a';
const ARTIFACT = 'https://claude.ai/artifact/9c1e';
const FIGMA = 'https://www.figma.com/file/abc';

describe('isClaudeDesignLink', () => {
  it('knows a Claude design at its old address and its new one', () => {
    expect(isClaudeDesignLink(DESIGN)).toBe(true);
    expect(isClaudeDesignLink(ARTIFACT)).toBe(true);
    expect(isClaudeDesignLink(' https://claude.ai/code/artifact/1b2c ')).toBe(true);
  });

  it('is not fooled by other pages, other hosts or other schemes', () => {
    expect(isClaudeDesignLink('https://claude.ai/chat/123')).toBe(false);
    expect(isClaudeDesignLink('https://claude.ai/designer')).toBe(false);
    expect(isClaudeDesignLink('https://claude.ai.evil.example/design/x')).toBe(false);
    expect(isClaudeDesignLink('http://claude.ai/design/x')).toBe(false);
    expect(isClaudeDesignLink(FIGMA)).toBe(false);
    expect(isClaudeDesignLink('not a link')).toBe(false);
  });
});

describe('what the agent is told about the links', () => {
  it('asks Claude Code to open a Claude design, and says what to do when it cannot', () => {
    const block = designLinksBlock([DESIGN, FIGMA], 'claude');
    expect(block).toContain('try to read each with your Artifact tool');
    expect(block).toContain('say in your summary which');
    expect(block.indexOf(DESIGN)).toBeLessThan(block.indexOf('may not be able to open'));
    expect(block.indexOf(FIGMA)).toBeGreaterThan(block.indexOf('may not be able to open'));
  });

  it('does not tell Codex it can open one', () => {
    const block = designLinksBlock([ARTIFACT], 'codex');
    expect(block).not.toContain('Artifact tool');
    expect(block).toContain('may not be able to open');
    expect(block).toContain(ARTIFACT);
  });

  it('says nothing when there are no links', () => {
    expect(designLinksBlock([], 'claude')).toBe('');
  });

  it('splits the links without losing any', () => {
    expect(splitDesignLinks([FIGMA, DESIGN, ARTIFACT])).toEqual({
      claude: [DESIGN, ARTIFACT],
      other: [FIGMA],
    });
  });
});
