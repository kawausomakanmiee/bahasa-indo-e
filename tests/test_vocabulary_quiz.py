"""ブラウザ回帰テスト: python3 tests/test_vocabulary_quiz.py

Python Playwright と Chromium が必要。既存サーバーやユーザーの記録は使わず、
一時HTTPサーバーとテストごとの独立したブラウザコンテキストで実行する。
"""
import functools
import json
import re
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import unittest

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
WORDS = json.loads((ROOT / 'data/vocabulary.json').read_text())['words']


def test_text(text):
    previous = None
    while text != previous:
        previous = text
        text = re.sub(r'[（(][^()（）]*[)）]', '', text)
    return ' '.join(text.split())


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


class VocabularyQuizTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT)))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 375, 'height': 812}, has_touch=True)
        self.page = self.context.new_page()
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.goto(self.url, wait_until='networkidle')

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def button(self, name):
        return self.page.get_by_role('button', name=name, exact=True)

    def menu(self, direction='id2ja'):
        self.page.evaluate('window.IdVocab.openTest()')
        self.page.locator('#vt-direction').select_option(direction)

    def store(self):
        return self.page.evaluate('window.IdVocab.exportData()')

    def answer(self, direction, correct=True):
        prompt = self.page.locator('#app h2').inner_text()
        source, target = ('indonesian', 'japanese') if direction == 'id2ja' else ('japanese', 'indonesian')
        answers = {test_text(w[target]) for w in WORDS if test_text(w[source]) == prompt}
        choices = self.page.locator('.choice .ctext').all_text_contents()
        self.assertEqual(len(choices), 4)
        self.assertEqual(len(set(choices)), 4)
        self.assertEqual(sum(c in answers for c in choices), 1)
        selected = next(i for i, c in enumerate(choices) if (c in answers) == correct)
        self.page.locator('button.choice').nth(selected).click()
        self.assertEqual(self.page.locator('button.choice:disabled').count(), 4)
        self.assertEqual(self.page.locator('#vt-feedback .verdict').inner_text(), '正解！' if correct else '不正解')
        # 小さい画面でも横にはみ出さず、48px以上のタップ領域を保つ。
        self.assertTrue(self.page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
        for button in self.page.locator('button.choice').all():
            self.assertGreaterEqual(button.bounding_box()['height'], 48)
        return prompt

    def test_both_directions_ten_unique_questions_and_review(self):
        for direction in ['id2ja', 'ja2id']:
            self.menu(direction)
            self.button('10問テストを始める').click()
            prompts = []
            for i in range(10):
                prompts.append(self.answer(direction, correct=i != 0))
                self.button('結果を見る' if i == 9 else '次の問題へ').click()
            self.assertEqual(self.page.locator('.score .big').inner_text(), '9 / 10')
            records = self.store()['tests'][direction]
            self.assertEqual(len(records), 10)
            self.assertEqual(sum(r['attempts'] for r in records.values()), 10)
            self.assertEqual(sum(r['correct'] for r in records.values()), 9)
            self.button('今回間違えた単語を復習').click()
            self.assertEqual(self.page.locator('.num').inner_text(), '1 / 1問')
            self.assertEqual(self.answer(direction), prompts[0])
            self.button('結果を見る').click()
            self.assertFalse(any(r['review'] for r in self.store()['tests'][direction].values()))
        saved = self.store()
        self.page.reload(wait_until='networkidle')
        self.assertEqual(self.store(), saved)

    def test_legacy_records_backup_and_direction_specific_review(self):
        legacy = {'v': 1, 'words': {'rumah': {'known': True, 'seen': 7, 'last': '2026-01-01'}}}
        self.page.evaluate('(data) => window.IdVocab.importData(data)', legacy)
        self.menu()
        self.button('10問テストを始める').click()
        self.answer('id2ja', correct=False)
        saved = self.store()
        self.assertEqual(saved['words'], legacy['words'])
        self.page.reload(wait_until='networkidle')
        self.menu()
        self.button('間違えた単語だけ復習(1問)').click()
        self.answer('id2ja', correct=False)
        self.page.evaluate('window.IdVocab.openTest()')
        self.page.locator('#vt-direction').select_option('ja2id')
        self.assertTrue(self.button('間違えた単語だけ復習(0問)').is_disabled())
        saved = self.store()
        self.page.evaluate('window.IdVocab.reset()')
        self.assertEqual(self.store()['tests'], {'id2ja': {}, 'ja2id': {}})
        self.page.evaluate('(data) => window.IdVocab.importData(data)', saved)
        self.assertEqual(self.store(), saved)
        self.page.evaluate('(data) => window.IdVocab.importData(data)', legacy)
        self.assertEqual(self.store()['words'], legacy['words'])
        self.assertEqual(self.store()['tests'], {'id2ja': {}, 'ja2id': {}})

    def test_existing_practice_exam_cards_and_backup(self):
        self.button('基本語彙から始める').click()
        self.page.locator('button.choice').first.click()
        self.assertTrue(self.page.locator('#next-btn').is_visible())
        practice = self.page.evaluate("JSON.parse(localStorage.getItem('idE_taisaku_v1')).records")
        self.button('ホームへ戻る').click()
        self.page.get_by_role('button', name='語彙学習 単語の一覧とカード学習').click()
        self.page.locator('#v-q').fill('rumah')
        self.page.locator('.vcard').filter(has=self.page.get_by_text('rumah', exact=True)).get_by_role('button', name='覚えた', exact=True).click()
        self.page.get_by_role('button', name='この絞り込みでカード学習').click()
        self.button('答えを見る').click()
        self.button('覚えた').click()
        self.assertTrue(self.store()['words']['rumah']['known'])
        self.button('ホームへ戻る').click()
        self.page.get_by_role('button', name='模擬試験 時間を計って挑戦').click()
        self.page.locator('#ex-count').fill('1')
        self.button('開始する').click()
        self.page.locator('button.choice').first.click()
        self.page.once('dialog', lambda dialog: dialog.accept())
        self.button('試験を終了する').click()
        self.assertEqual(len(self.page.evaluate("JSON.parse(localStorage.getItem('idE_taisaku_v1')).exams")), 1)
        for key, record in practice.items():
            current = self.page.evaluate("JSON.parse(localStorage.getItem('idE_taisaku_v1')).records")[key]
            self.assertGreaterEqual(current['attempts'], record['attempts'])
        self.menu()
        self.button('10問テストを始める').click()
        self.answer('id2ja')
        vocab = self.store()
        self.button('ホームへ戻る').click()
        self.page.get_by_role('button', name='学習記録 進捗・苦手分野').click()
        with self.page.expect_download() as info:
            self.page.get_by_role('button', name='書き出す', exact=False).click()
        payload = json.loads(Path(info.value.path()).read_text())
        self.assertEqual(payload['vocab'], vocab)
        self.page.evaluate('window.IdVocab.reset()')
        self.page.on('dialog', lambda dialog: dialog.accept())
        self.page.locator('#import-file').set_input_files({'name': 'backup.json', 'mimeType': 'application/json', 'buffer': json.dumps(payload).encode()})
        self.page.wait_for_function("window.IdVocab.exportData().words.rumah.known")
        self.assertEqual(self.store(), vocab)

    def test_review_limit_and_unanswered_interrupt(self):
        words = WORDS[:12]
        records = {(w.get('id') or w['indonesian'].lower()):
                   {'attempts': 1, 'correct': 0, 'review': True, 'last': None} for w in words}
        self.page.evaluate('(data) => window.IdVocab.importData(data)',
                           {'v': 1, 'words': {}, 'tests': {'id2ja': records}})
        self.menu()
        self.button('間違えた単語だけ復習(10問)').click()
        before = self.store()
        self.button('中断してテストのメニューへ').click()
        self.assertEqual(self.store(), before)
        self.button('間違えた単語だけ復習(10問)').click()
        prompts = []
        for i in range(10):
            prompts.append(self.answer('id2ja'))
            self.button('結果を見る' if i == 9 else '次の問題へ').click()
        self.assertEqual(len(set(prompts)), 10)
        self.assertTrue(set(prompts).issubset({w['indonesian'] for w in words}))
        self.assertEqual(sum(r['review'] for r in self.store()['tests']['id2ja'].values()), 2)

    def test_parenthetical_hints_only_appear_after_answer(self):
        # 実データの半角・全角・文頭の括弧、および補足を除くと同じ訳になる語。
        for word_id in ['memanggil', 'selamat siang', 'mahal', 'kami', 'kita']:
            word = next(w for w in WORDS if w['indonesian'] == word_id)
            key = word.get('id') or word_id.lower()
            for direction in ['id2ja', 'ja2id']:
                with self.subTest(word=word_id, direction=direction):
                    self.page.evaluate('(data) => window.IdVocab.importData(data)', {
                        'v': 1, 'words': {}, 'tests': {direction: {
                            key: {'attempts': 1, 'correct': 0, 'review': True, 'last': None}}}})
                    self.menu(direction)
                    self.button('間違えた単語だけ復習(1問)').click()
                    before = self.page.locator('#app').inner_text()
                    self.assertNotIn(word['japanese'], before)
                    for text in self.page.locator('.choice .ctext, #app h2').all_text_contents():
                        self.assertNotRegex(text, r'[()（）]')
                    self.assertEqual(self.page.locator('#vt-feedback').count(), 0)
                    self.answer(direction)
                    self.assertIn(word['indonesian'] + ' → ' + word['japanese'],
                                  self.page.locator('#vt-feedback').inner_text())
                    self.assertEqual(self.store()['tests'][direction][key]['correct'], 1)
                    self.assertFalse(self.store()['tests'][direction][key]['review'])

    def test_unavailable_storage_warns_but_allows_answer(self):
        self.page.evaluate("() => { Storage.prototype.setItem = function () { throw new Error('blocked'); }; }")
        self.menu()
        self.button('10問テストを始める').click()
        self.answer('id2ja')
        self.assertTrue(self.page.get_by_role('alert').is_visible())
        self.button('次の問題へ').click()
        self.answer('id2ja')


if __name__ == '__main__':
    unittest.main(verbosity=2)
