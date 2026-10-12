"""Synthetic pixels and expected observations share the same row definitions.
--keep-images DIR preserves pages for vision; --render-only explicitly skips OCR.
"""
import argparse
import contextlib
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import time
import copy
from PIL import Image, ImageDraw, ImageFilter, ImageFont


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def row(name, value, unit='U/L', reference='0-99', **extra):
    return dict(name=name, value=float(value.lstrip('<>≤≥')), resultText=value,
                unit=unit, referenceText=reference, trendEligible=not value.startswith(('<', '>', '≤', '≥')), **extra)


def synthetic_cases(font_path):
    base = [row('丙氨酸氨基转移酶', '12.5'), row('天门冬氨酸氨基转移酶', '24.6'), row('γ-谷氨酰转移酶', '36.7')]
    headers = ['项目名称', '结果', '单位', '参考范围']

    def page(rows, labels=headers, size=34, wrapped=False, heading=True):
        image = Image.new('RGB', (1800, 620), 'white')
        draw = ImageDraw.Draw(image)
        font = ImageFont.truetype(font_path, size)
        x = [80, 860, 1130, 1400]
        if heading:
            for column, label in enumerate(labels):
                draw.text((x[column], 60), label, font=font, fill='black')
        for index, item in enumerate(rows):
            name = '丙氨酸氨基\n转移酶' if wrapped and index == 0 else item['name']
            cells = [name, item['resultText'], item['unit'] or '', item['referenceText'] or '']
            for column, value in enumerate(cells[:len(labels)]):
                draw.multiline_text((x[column], 150 + index * 130), value, font=font, fill='black', spacing=5)
            item['sourceBox'] = [x[0] - 20, 130 + index * 130, x[1] - 30, 250 + index * 130]
        return image

    cases = []
    for name, labels, angle in [('horizontal', headers, 0), ('tilted-positive', headers, 4),
                                ('tilted-negative', headers, -4), ('english', ['Test', 'Result', 'Unit', 'Reference'], 0),
                                ('two-column', ['项目名称', '结果'], 0)]:
        rows = [{**item, **({'unit': None, 'referenceText': None, 'trendEligible': False} if len(labels) == 2 else {})} for item in base]
        image = page(rows, labels)
        if angle:
            original = image
            image = original.rotate(angle, expand=True, fillcolor='white', resample=Image.Resampling.BICUBIC)
            radians = math.radians(angle)
            for item in rows:
                left, top, right, bottom = item['sourceBox']
                points = [(math.cos(radians) * (x - original.width / 2) + math.sin(radians) * (y - original.height / 2) + image.width / 2,
                           -math.sin(radians) * (x - original.width / 2) + math.cos(radians) * (y - original.height / 2) + image.height / 2)
                          for x, y in [(left, top), (right, top), (right, bottom), (left, bottom)]]
                item['sourceBox'] = [min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points), max(p[1] for p in points)]
            original.close()
        cases.append((name, [image], [{**item, 'pageNumber': 1} for item in rows]))

    # Independent side-by-side tables with different result/unit column orders.
    image = Image.new('RGB', (3300, 650), 'white')
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(font_path, 34)
    left, right = base[:2], [base[2], row('碱性磷酸酶', '48.8')]
    for origin, rows, order in [(60, left, [0, 1, 2, 3]), (1740, right, [0, 2, 1, 3])]:
        positions = [0, 790, 1000, 1240]
        for c, field in enumerate(order):
            draw.text((origin + positions[c], 70), headers[field], font=font, fill='black')
        for r, item in enumerate(rows):
            cells = [item['name'], item['resultText'], item['unit'], item['referenceText']]
            for c, field in enumerate(order):
                draw.text((origin + positions[c], 190 + r * 140), cells[field], font=font, fill='black')
            item['sourceBox'] = [origin - 20, 170 + r * 140, origin + positions[1] - 30, 290 + r * 140]
    cases.append(('parallel-tables', [image], [{**item, 'pageNumber': 1} for item in left + right]))
    cases.append(('cross-page-continuation', [page(base[:2]), page(base[2:], heading=False)],
                  [{**item, 'pageNumber': 1 if index < 2 else 2} for index, item in enumerate(base)]))

    image = Image.new('RGB', (1900, 500), 'white')
    draw = ImageDraw.Draw(image)
    dates = ['2026-01-01', '2026-02-01']
    x = [70, 750, 1060, 1400, 1580]
    for c, value in enumerate(['项目名称', *dates, '单位', '参考范围']):
        draw.text((x[c], 70), value, font=font, fill='black')
    temporal = [row(base[0]['name'], '12.5', timeText=dates[0]), row(base[0]['name'], '24.6', timeText=dates[1])]
    for item in temporal:
        item['sourceBox'] = [50, 180, 710, 280]
    for c, value in enumerate([base[0]['name'], *[item['resultText'] for item in temporal], 'U/L', '0-99']):
        draw.text((x[c], 200), value, font=font, fill='black')
    cases.append(('multi-date-columns', [image], [{**item, 'pageNumber': 1} for item in temporal]))
    cases.append(('wrapped-item', [page(base, wrapped=True)], [{**item, 'pageNumber': 1} for item in base]))
    cases.append(('small-font', [page(base, size=18)], [{**item, 'pageNumber': 1} for item in base]))
    cases.append(('blurred', [page(base).filter(ImageFilter.GaussianBlur(1.2))], [{**item, 'pageNumber': 1} for item in base]))
    bounded = [row('丙氨酸氨基转移酶', '<0.2', reference='0-40'), *base[1:]]
    cases.append(('bounded-result', [page(bounded)], [{**item, 'pageNumber': 1} for item in bounded]))
    return cases


def extended_cases(font_path, alternate_font=None):
    """Reuse golden item/unit definitions; all measurements below are synthetic.

    Golden source/result text and original measurements are never copied into
    images. The legacy 36 expected occurrences above remain unchanged.
    """
    fixture_dir = Path(__file__).resolve().parent.parent / 'packages/server/tests/fixtures'

    def metric(name, value, unit, low=10, high=90, flag=None, eligible=True, **extra):
        return dict(name=name, value=value, resultText=str(value) if value is not None else '阴性', unit=unit,
                    referenceText=f'{low}-{high}' if low is not None and high is not None else None,
                    referenceLow=low, referenceHigh=high, abnormalFlag=flag, trendEligible=eligible, **extra)

    def from_golden(filename, indices, category):
        existing = json.loads((fixture_dir / filename).read_text())['expected']['observations']
        rows = []
        for position, index in enumerate(indices):
            definition = existing[index]
            unit, canonical = definition.get('unit', definition.get('sourceUnit')), definition.get('canonicalUnit')
            item = metric(definition['normalizedName'], 20 + position * 7, unit,
                          goldenDefinition={'fixture': filename, 'observationIndex': index}, category=category)
            # Existing ECG goldens distinguish printed mv from canonical mV.
            # Trends use the canonical spelling and keep only numeric bounds
            # when the printed reference's unit spelling differs.
            if unit and canonical and unit != canonical and unit.casefold() == canonical.casefold():
                item['trendExpected'] = {'unit': canonical, 'referenceText': None}
            rows.append(item)
        return rows

    devices = from_golden('p3-ecg-measurement-planner-golden.json', [0, 4, 5], 'ecg')
    devices += from_golden('p3-body-composition-planner-golden.json', [0, 2, 5], 'body-composition')
    lipids = from_golden('p3-cross-line-indicator-continuation-golden.json', [0, 1, 2], 'lipid')
    laboratory = [metric('白细胞计数', 7, '10^9/L', 4, 10),
                  metric('红细胞计数', 5, '10^12/L', 4, 6),
                  metric('血红蛋白', 12, 'g/dL', 10, 16,
                         trendExpected={'value': 120, 'unit': 'g/L', 'referenceLow': 100, 'referenceHigh': 160, 'referenceText': None}),
                  metric('尿蛋白', None, None, None, None, eligible=False)]
    laboratory[-1]['referenceText'] = '阴性'
    flags = [metric('丙氨酸氨基转移酶', 95, 'U/L', 10, 90, 'high'),
             metric('天门冬氨酸氨基转移酶', 5, 'U/L', 10, 90, 'low')]

    def table(rows, chosen_font=font_path, dense=False, heading=True):
        rows = copy.deepcopy(rows)
        width, step, size = (1900, 66, 29) if dense else (1900, 104, 34)
        image = Image.new('RGB', (width, 175 + step * len(rows)), 'white')
        draw = ImageDraw.Draw(image)
        font = ImageFont.truetype(chosen_font, size)
        columns = [65, 850, 1060, 1270, 1560]
        if heading:
            for x, label in zip(columns, ['项目名称', '结果', '提示', '单位', '参考范围']):
                draw.text((x, 45), label, font=font, fill='black')
        for index, item in enumerate(rows):
            y = 130 + index * step
            cells = [item['name'], item['resultText'], {'high': '↑', 'low': '↓'}.get(item['abnormalFlag'], ''),
                     item['unit'] or '', item['referenceText'] or '']
            for x, text in zip(columns, cells):
                draw.text((x, y), text, font=font, fill='black')
            item.update(pageNumber=1, sourceBox=[45, y - 5, 825, y + size + 10])
        return image, rows

    cases = []
    for name, rows, dense in [('golden-device-metrics', devices, False), ('mixed-laboratory', laboratory + flags, False),
                              ('dense-mixed-metrics', devices + lipids + laboratory + flags, True)]:
        image, expected = table(rows, dense=dense)
        cases.append((name, [image], expected))
    if alternate_font:
        image, expected = table(devices + lipids, chosen_font=alternate_font, dense=True)
        cases.append(('alternate-font', [image], expected, {'fontPath': alternate_font}))

    # A visible paper border and four in-frame corners make perspective an
    # independently testable camera distortion, rather than another rotation.
    import cv2
    import numpy as np
    for name in ['photo-perspective', 'photo-shadow', 'photo-glare']:
        paper, expected = table(laboratory)
        width, height = paper.size
        origin = np.float32([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]])
        target = np.float32([[250, 80], [width - 80, 110], [width + 80, height + 110], [90, height + 140]])
        transform = cv2.getPerspectiveTransform(origin, target)
        pixels = cv2.warpPerspective(np.asarray(paper), transform, (width + 180, height + 220), borderValue=(75, 80, 85))
        for item in expected:
            left, top, right, bottom = item['sourceBox']
            points = cv2.perspectiveTransform(np.float32([[[left, top], [right, top], [right, bottom], [left, bottom]]]), transform)[0]
            item['sourceBox'] = [float(points[:, 0].min()), float(points[:, 1].min()), float(points[:, 0].max()), float(points[:, 1].max())]
        if name == 'photo-shadow':
            shade = np.linspace(.38, 1, pixels.shape[1])[None, :, None]
            pixels = np.clip(pixels * shade, 0, 255).astype('uint8')
        elif name == 'photo-glare':
            yy, xx = np.mgrid[:pixels.shape[0], :pixels.shape[1]]
            glare = .94 * np.exp(-(((xx - width * .49) / 170) ** 2 + ((yy - height * .55) / 160) ** 2))
            pixels = np.clip(pixels * (1 - glare[:, :, None]) + 255 * glare[:, :, None], 0, 255).astype('uint8')
        paper.close()
        cases.append((name, [Image.fromarray(pixels)], expected, {'distortion': name}))

    # Two pages force a separate scalar route for unknown, explicitly named
    # synthetic measurements. No expected output is supplied to the extractor.
    hard = [metric('合成检测项甲', 17, 'U/L', None, None), metric('合成检测项乙', 23, 'mg/L', None, None)]
    images, expected = [], []
    for number, item in enumerate(hard, 1):
        image, rows = table([item], heading=False)
        rows[0]['pageNumber'] = number
        images.append(image)
        expected.extend(rows)
    cases.append(('ai-scalar-required', images, expected))
    image, expected = table([metric('合成检测项甲', .12, 'U/L', None, None, eligible=False)], heading=False)
    cases.append(('ai-visual-value-conflict', [image], expected, {'controlledOcrFault': {'from': '0.12', 'to': 'O.12'}}))
    # Name corrections based on an image remain behind the manual-review gate.
    image, expected = table([metric('γ-谷氨酰转肽酶', 36, 'U/L', eligible=False)])
    cases.append(('ai-visual-name-correction', [image], expected,
                  {'controlledOcrFault': {'field': 'name', 'to': 'Y-谷氨酰转肽酶'}}))
    return cases


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--worker', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--font', required=True)
    parser.add_argument('--keep-images')
    parser.add_argument('--render-only', action='store_true')
    parser.add_argument('--alternate-font', help='Optional second font for a separately labelled layout')
    parser.add_argument('--cases', help='Optional comma-separated layout names')
    args = parser.parse_args()
    worker_path = Path(args.worker).resolve()
    sys.path.insert(0, str(worker_path.parent))
    spec = importlib.util.spec_from_file_location('layout_worker', worker_path)
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    output = []
    with open(os.devnull, 'w') as quiet, tempfile.TemporaryDirectory(prefix='ocr-layout-pixels-') as directory:
        destination = Path(args.keep_images).resolve() if args.keep_images else Path(directory)
        destination.mkdir(parents=True, exist_ok=True)
        backend = None
        if not args.render_only:
            with contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
                backend = worker.load_engine()
        metadata = {'status': 'skipped' if args.render_only else 'executed', 'reason': 'render_only' if args.render_only else None,
                    'backend': backend['name'] if backend else None, 'version': backend['version'] if backend else None,
                    'workerSha256': digest(worker_path), 'fontSha256': digest(args.font), 'pythonVersion': sys.version.split()[0]}
        for definition in synthetic_cases(args.font) + extended_cases(args.font, args.alternate_font):
            name, images, expected = definition[:3]
            if args.cases and name not in args.cases.split(','):
                for image in images:
                    image.close()
                continue
            details = definition[3] if len(definition) > 3 else {}
            case_metadata = {**metadata, 'fontSha256': digest(details.get('fontPath', args.font))}
            pages, total_ms = [], 0
            for index, image in enumerate(images):
                path = destination / (name + '-page-' + str(index + 1) + '.png')
                image.save(path)
                lines = []
                started = time.monotonic()
                if backend:
                    with contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
                        lines, _ = worker.recognize_image(backend['engine'], path, None)
                engine_lines = copy.deepcopy(lines)
                fault = details.get('controlledOcrFault')
                if fault and backend:
                    changed, targeted = 0, 0
                    for line in lines:
                        selected = line.get('text', '').strip() == fault.get('from')
                        if fault.get('field') == 'name':
                            box = line.get('box')
                            if box and isinstance(box[0], (list, tuple)):
                                box = [min(p[0] for p in box), min(p[1] for p in box), max(p[0] for p in box), max(p[1] for p in box)]
                            if box and len(box) == 4 and isinstance(box[0], (int, float)):
                                cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
                                left, top, right, bottom = expected[0]['sourceBox']
                                selected = left <= cx <= right and top <= cy <= bottom
                        if selected:
                            targeted += 1
                            changed += int(line['text'] != fault['to'])
                            line['text'] = fault['to']
                    case_metadata.update(status='modified', engineStatus='executed',
                                         reason='controlled_ocr_fault_after_engine_execution' if changed else 'controlled_ocr_fault_already_present' if targeted else 'controlled_ocr_fault_target_not_found',
                                         modifiedLines=changed, targetedLines=targeted)
                elapsed = round((time.monotonic() - started) * 1000) if backend else 0
                total_ms += elapsed
                pages.append({'pageNumber': index + 1, 'lines': lines, 'elapsedMs': elapsed,
                              'imageSha256': digest(path), 'imagePath': str(path) if args.keep_images else None,
                              **({'engineLines': engine_lines} if fault else {})})
                image.close()
            output.append({'name': name, 'lines': pages[0]['lines'], 'pages': pages, 'expected': expected,
                           'elapsedMs': total_ms, 'ocr': case_metadata})
    Path(args.output).write_text(json.dumps(output, ensure_ascii=False))
    print(json.dumps({'layouts': len(output), 'pages': sum(len(item['pages']) for item in output),
                      'expectedItems': sum(len(item['expected']) for item in output), 'ocr': metadata['status']}))


if __name__ == '__main__':
    main()
