#!/usr/bin/env node
/* 分类维护工具（在项目根目录运行；建议先停服务再执行，跑完重启）
 *
 *   node tools/categories.js repair
 *       修复"分类/标签引用失效"：指到不存在分类的书会按名称找回，找不回则清空
 *       （跨实例导入备份后出现"有分类却显示未分类"时用）
 *
 *   node tools/categories.js merge 人文与社科 人文与文化 社会科学
 *       把后面的分类合并进第一个（迁移书籍引用后删除），第一个不存在会自动创建
 *
 *   node tools/categories.js list
 *       列出分类及各自的书籍数量
 */
'use strict';
const path = require('path');
process.chdir(path.resolve(__dirname, '..'));
const store = require(path.resolve(__dirname, '..', 'server', 'store'));

const [cmd, ...args] = process.argv.slice(2);
const cats = () => store.listCategories();
const books = () => store.listBooks();
const countOf = (id) => books().filter((b) => b.categoryId === id).length;

if (cmd === 'list') {
  for (const c of cats().sort((a, b) => countOf(b.id) - countOf(a.id))) {
    console.log(`${String(countOf(c.id)).padStart(4)}  本  ${c.name}  (${c.id})`);
  }
  const none = books().filter((b) => !b.categoryId).length;
  console.log(`${String(none).padStart(4)}  本  未分类`);
} else if (cmd === 'repair') {
  let fixed = 0;
  let cleared = 0;
  for (const b of books()) {
    if (!b.categoryId) continue;
    if (cats().some((c) => c.id === b.categoryId)) continue;
    const name = String(b.categoryId).replace(/^c_\d+_/, '');
    const hit = cats().find((c) => c.name === name);
    store.updateBook(b.id, { categoryId: hit ? hit.id : '' });
    if (hit) fixed += 1;
    else cleared += 1;
  }
  console.log(`修复引用 ${fixed} 条，清空无效引用 ${cleared} 条`);
  const tags = new Set(store.listTags().map((t) => t.id));
  let tagFixed = 0;
  for (const b of books()) {
    const kept = (b.tagIds || []).filter((id) => tags.has(id));
    if (kept.length !== (b.tagIds || []).length) {
      store.updateBook(b.id, { tagIds: kept });
      tagFixed += 1;
    }
  }
  console.log(`清理无效标签引用 ${tagFixed} 条`);
} else if (cmd === 'merge') {
  const [main, ...rest] = args;
  if (!main || !rest.length) {
    console.log('用法: node tools/categories.js merge 主分类名 待合并分类名 [更多...]');
    process.exit(1);
  }
  let keep = cats().find((c) => c.name === main);
  if (!keep) keep = store.addCategory({ name: main, color: '#64748b' });
  console.log(`保留「${keep.name}」(${keep.id})`);
  let moved = 0;
  for (const name of rest) {
    const hit = cats().find((c) => c.name === name);
    if (!hit) {
      console.log(`  跳过「${name}」（不存在）`);
      continue;
    }
    for (const b of books()) {
      if (b.categoryId === hit.id) {
        store.updateBook(b.id, { categoryId: keep.id });
        moved += 1;
      }
    }
    store.deleteCategory(hit.id);
    console.log(`  已合并并删除「${name}」`);
  }
  console.log(`迁移书籍 ${moved} 条；现有分类 ${cats().length} 个`);
} else {
  console.log('用法: node tools/categories.js list | repair | merge 主分类 待合并分类...');
}
