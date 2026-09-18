import { decodeHTML } from 'entities'
import { Lexer, type MarkedToken, type Token, type Tokens } from 'marked'
import { decodeMarkdown, MarkdownInputError } from '../server/documents/markdown'

export const MARKDOWN_EXTRACTION_VERSION = 'score-markdown-extraction-v1'

const CORE_TYPES = new Set([
  'blockquote', 'br', 'checkbox', 'code', 'codespan', 'def', 'del', 'em', 'escape', 'heading',
  'hr', 'html', 'image', 'link', 'list', 'list_item', 'paragraph', 'space', 'strong', 'table', 'text',
])

function coreToken(token: Token): token is MarkedToken {
  return CORE_TYPES.has(token.type)
}

function tableText(token: Tokens.Table): string {
  return [token.header, ...token.rows].map(row => row.map(cell => inlineText(cell.tokens)).join(' | ')).join('\n')
}

function inlineText(tokens: Token[]): string {
  return tokens.map(token => {
    if (!coreToken(token)) throw new MarkdownInputError('invalid-markdown', 'This Markdown contains unsupported syntax.')
    switch (token.type) {
      case 'br': case 'space': case 'hr': return '\n'
      case 'strong': case 'em': case 'del': case 'paragraph': case 'heading':
      case 'blockquote': case 'list_item': return inlineText(token.tokens)
      case 'text': return token.tokens ? inlineText(token.tokens) : decodeHTML(token.text)
      case 'escape': case 'code': case 'codespan': case 'html': return token.text
      case 'def': case 'checkbox': return token.raw
      case 'table': return tableText(token)
      case 'list': return token.items.map(item => inlineText(item.tokens)).join('\n')
      case 'image': return inlineText(token.tokens)
      case 'link': {
        const label = inlineText(token.tokens)
        const href = token.autolink ? token.href : decodeHTML(token.href)
        return label === href || href === `mailto:${label}` ? label : `${label} (${href})`
      }
    }
  }).join('')
}

export function extractMarkdownBlocks(bytes: Uint8Array): {
  title?: string
  blocks: Array<{ heading?: string; text: string }>
} {
  const text = decodeMarkdown(bytes)
  const blocks: Array<{ heading?: string; text: string }> = []
  let heading: string | undefined
  let title: string | undefined

  function visit(tokens: Token[], prefix = '') {
    function add(value: string) {
      if (!value.trim()) return
      blocks.push({ heading, text: `${prefix}${value}` })
      prefix = ''
    }
    for (const token of tokens) {
      if (!coreToken(token)) throw new MarkdownInputError('invalid-markdown', 'This Markdown contains unsupported syntax.')
      switch (token.type) {
        case 'space': case 'hr': break
        case 'heading':
          heading = inlineText(token.tokens)
          if (!title && token.depth === 1) title = heading
          add(heading)
          break
        case 'blockquote':
          visit(token.tokens, prefix)
          prefix = ''
          break
        case 'checkbox':
          prefix += `${token.raw.trim()} `
          break
        case 'list':
          token.items.forEach((item, index) => {
            const marker = token.ordered ? `${Number(token.start) + index}. ` : '- '
            visit(item.tokens, `${prefix}${marker}`)
            prefix = ''
          })
          break
        case 'table': add(tableText(token)); break
        default: add(inlineText([token]))
      }
    }
  }

  try {
    // A private lexer prevents another consumer's Markdown extensions from changing evidence.
    visit(new Lexer({ gfm: true }).lex(text))
  } catch (cause) {
    if (cause instanceof MarkdownInputError) throw cause
    throw new MarkdownInputError('invalid-markdown', 'This Markdown could not be parsed. Simplify its formatting and import it again.', { cause })
  }
  return { title, blocks }
}
