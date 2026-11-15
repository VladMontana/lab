import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { convertDocxToMarkdown } from './src/lib/docx.ts';

console.log('=== Running DOCX Converter Tests ===');

async function testSimpleDocx() {
  console.log('--- 1. Testing simple DOCX conversion ---');
  const samplePath = path.resolve(__dirname, './test-fixtures/test_sample.docx');
  const buffer = fs.readFileSync(samplePath);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

  const result = await convertDocxToMarkdown(arrayBuffer);

  assert.ok(result.markdown, 'Markdown should not be empty');
  assert.ok(result.markdown.includes('Лабораторная работа №1'), 'Should contain main heading');
  assert.ok(result.markdown.includes('Введение в практическую работу'), 'Should contain intro text');
  assert.ok(result.markdown.includes('Цель работы'), 'Should contain H2 heading');
  assert.ok(result.markdown.includes('Порядок выполнения'), 'Should contain H2 heading');
  assert.ok(result.markdown.includes('Запустить тестовый стенд'), 'Should contain ordered list item');
  assert.strictEqual(result.title, 'Лабораторная работа №1: Исследование алгоритмов', 'Title should be extracted');
  assert.strictEqual(result.imageCount, 0, 'No images in sample docx');
  assert.strictEqual(result.uploadedImagesCount, 0, 'No uploaded images');

  console.log('✓ Simple DOCX conversion passed');
}

async function testDocxWithImagesFallback() {
  console.log('--- 2. Testing DOCX with images (Base64 fallback) ---');
  const samplePath = path.resolve(__dirname, './test-fixtures/test_with_image.docx');
  const buffer = fs.readFileSync(samplePath);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

  const result = await convertDocxToMarkdown(arrayBuffer);

  assert.ok(result.markdown.includes('Лабораторная работа с картинкой'), 'Should contain heading');
  assert.ok(result.markdown.includes('Текст перед картинкой'), 'Should contain preceding text');
  assert.ok(result.markdown.includes('Текст после картинки'), 'Should contain following text');
  assert.strictEqual(result.imageCount, 1, 'Should find 1 image');
  assert.strictEqual(result.uploadedImagesCount, 0, 'Fallback used, uploaded count 0');
  assert.ok(result.markdown.includes('data:image/png;base64,'), 'Should contain inline base64 image');
  assert.ok(result.markdown.includes('Архитектурная схема'), 'Should preserve alt text');

  console.log('✓ Base64 fallback image conversion passed');
}

async function testDocxWithImageUpload() {
  console.log('--- 3. Testing DOCX with image upload handler ---');
  const samplePath = path.resolve(__dirname, './test-fixtures/test_with_image.docx');
  const buffer = fs.readFileSync(samplePath);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

  const uploadedUrls = [];
  const mockUpload = async (blob, filename, contentType) => {
    assert.ok(blob.size > 0, 'Blob size should be > 0');
    assert.strictEqual(contentType, 'image/png');
    assert.ok(filename.endsWith('.png'));
    const url = `/media/019324a1-b827-7201-9dc5-${filename}`;
    uploadedUrls.push(url);
    return url;
  };

  const result = await convertDocxToMarkdown(arrayBuffer, { uploadImage: mockUpload });

  assert.strictEqual(result.imageCount, 1, 'Should find 1 image');
  assert.strictEqual(result.uploadedImagesCount, 1, 'Should upload 1 image');
  assert.strictEqual(uploadedUrls.length, 1);
  assert.ok(result.markdown.includes(uploadedUrls[0]), 'Markdown should reference uploaded media URL');
  // Check that hyphen was not escaped
  assert.ok(!result.markdown.includes('\\-'), 'Markdown URLs should not have escaped hyphens');

  console.log('✓ Image upload handler conversion passed');
}

async function main() {
  try {
    await testSimpleDocx();
    await testDocxWithImagesFallback();
    await testDocxWithImageUpload();
    console.log('\n🎉 ALL DOCX TESTS PASSED SUCCESSFULLY!');
  } catch (err) {
    console.error('❌ Test failed:', err);
    process.exit(1);
  }
}

main();
