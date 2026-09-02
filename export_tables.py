"""
Export selected tables to CSV and JSON files.
Usage:
  python export_tables.py --tables employees,payroll --outdir output/exports
"""

import argparse
from pathlib import Path
import pandas as pd
from sqlalchemy import create_engine, text
import i18n


def connect_url(user, password, host, port, dbname):
    return f"postgresql+psycopg2://{user}:{password}@{host}:{port}/{dbname}"


def export_tables(engine, table_list, outdir):
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    with engine.connect() as conn:
        for t in table_list:
            df = pd.read_sql(text(f'SELECT * FROM {t}'), conn)
            csv_path = outdir / f"{t}.csv"
            json_path = outdir / f"{t}.json"
            df.to_csv(csv_path, index=False)
            df.to_json(json_path, orient='records', force_ascii=False)
            print(i18n.t('exported', table=t, csv=str(csv_path), json=str(json_path)))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--tables', required=True, help='Comma-separated table names')
    parser.add_argument('--outdir', default='output/exports')
    parser.add_argument('--dbuser', default='')
    parser.add_argument('--dbpass', default='')
    parser.add_argument('--dbname', default='')
    parser.add_argument('--host', default='')
    parser.add_argument('--port', default='')
    parser.add_argument('--lang', default='en', help='Language code: en or ar')
    args = parser.parse_args()

    try:
        from dotenv import dotenv_values
        env = dotenv_values('.env') or {}
    except Exception:
        env = {}

    args.dbuser = env.get('DB_USER') or args.dbuser or 'hradmin'
    args.dbpass = env.get('DB_PASS') or args.dbpass or 'change_me_now'
    args.dbname = env.get('DB_NAME') or args.dbname or 'hr_system'
    args.host = env.get('DB_HOST') or args.host or 'localhost'
    args.port = env.get('DB_PORT') or args.port or '5432'

    i18n.set_language(env.get('LANG') or args.lang)

    engine = create_engine(connect_url(args.dbuser, args.dbpass, args.host, args.port, args.dbname))
    table_list = [x.strip() for x in args.tables.split(',') if x.strip()]
    export_tables(engine, table_list, args.outdir)
