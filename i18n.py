import json
import os
from pathlib import Path

_locales = {}
_language = 'en'

def _load_locales():
    base = Path(__file__).parent
    # 1) load from a locales/ directory if present
    loc_dir = base / 'locales'
    if loc_dir.exists() and loc_dir.is_dir():
        for p in loc_dir.glob('*.json'):
            code = p.stem
            try:
                with p.open('r', encoding='utf-8') as f:
                    _locales[code] = json.load(f)
            except Exception:
                _locales[code] = {}
    # 2) also accept flat files named locales_en.json or locales-ar.json or en.json in repo root
    for p in base.glob('locales_*.json'):
        try:
            code = p.stem.split('_', 1)[1]
            with p.open('r', encoding='utf-8') as f:
                _locales[code] = json.load(f)
        except Exception:
            _locales[code] = {}
    for p in base.glob('locales-*.json'):
        try:
            code = p.stem.split('-', 1)[1]
            with p.open('r', encoding='utf-8') as f:
                _locales[code] = json.load(f)
        except Exception:
            _locales[code] = {}
    # 3) fallback: load en.json/ar.json if present
    for p in base.glob('*.json'):
        if p.stem in ('en', 'ar'):
            try:
                with p.open('r', encoding='utf-8') as f:
                    _locales[p.stem] = json.load(f)
            except Exception:
                _locales[p.stem] = {}

_load_locales()


def set_language(lang):
    global _language
    if lang and lang in _locales:
        _language = lang
    else:
        # fallback to language prefix (en-US -> en)
        short = (lang or '').split('-')[0]
        if short in _locales:
            _language = short
        else:
            _language = 'en'


def t(key, **kwargs):
    d = _locales.get(_language, {})
    s = d.get(key, None)
    if s is None:
        # fallback to english
        s = _locales.get('en', {}).get(key, key)
    try:
        return s.format(**kwargs)
    except Exception:
        return s
