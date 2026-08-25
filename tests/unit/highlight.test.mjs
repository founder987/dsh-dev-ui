/**
 * highlight 单元测试：语言推断 + shiki 渲染
 * 运行：node tests/unit/highlight.test.mjs（需先 pnpm build 产出 lib/highlight.js）
 */
import { detectLanguage, highlightCode } from '../../lib/highlight.js';
import assert from 'node:assert/strict';

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✅ ${name}`);
}

console.log('--- highlight 测试 ---');

// 1. 语言推断（扩展名 → shiki lang）
check('ts → typescript', () => assert.equal(detectLanguage('a.ts'), 'typescript'));
check('tsx → tsx', () => assert.equal(detectLanguage('a.tsx'), 'tsx'));
check('js → javascript', () => assert.equal(detectLanguage('a.js'), 'javascript'));
check('json → json', () => assert.equal(detectLanguage('a.json'), 'json'));
check('md → markdown', () => assert.equal(detectLanguage('a.md'), 'markdown'));
check('css → css', () => assert.equal(detectLanguage('a.css'), 'css'));
check('mjs → javascript', () => assert.equal(detectLanguage('a.mjs'), 'javascript'));
check('未知 → text', () => assert.equal(detectLanguage('a.unknown'), 'text'));

// 2. shiki 渲染（异步初始化）
const html = await highlightCode('const x: number = 1;', 'typescript');
check('渲染包含 shiki 结构', () => assert.ok(html.includes('shiki'), '应含 shiki class'));
check('渲染包含代码内容', () => assert.ok(html.includes('const'), '应含源码文本'));
check('渲染包含颜色样式', () => assert.ok(/style=/.test(html), '应含内联样式'));

// 3. 空源码
const htmlEmpty = await highlightCode('', 'typescript');
check('空源码可渲染', () => assert.ok(htmlEmpty.length > 0));

console.log(`\n全部通过：${passed} 项断言`);
