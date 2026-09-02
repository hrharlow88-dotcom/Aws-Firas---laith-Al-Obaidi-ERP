"""
Simple importer: reads sheets from the provided Excel file and loads them into PostgreSQL tables.
- Uses pandas.to_sql for initial import (fast), then you can refine schema/cleaning.
- Defaults use DB params that match docker-compose.yml; override with CLI args or env vars.

Usage example:
  python import_excel.py --file "Laith_Al-Obaidi_HR_System_2026.xlsx" \
    --dbuser hradmin --dbpass change_me_now --dbname hr_system --host localhost --port 5432

Note: install requirements.txt first (pip install -r requirements.txt)
"""

import argparse
import os
import pandas as pd
from sqlalchemy import create_engine, text
from sqlalchemy.engine.url import URL

import i18n

SHEET_TO_TABLE = {
    # Common sheet name patterns -> table names. Adjust as necessary.
    'Employees': 'employees',
    'Employee': 'employees',
    'Payroll': 'payroll',
    'Salaries': 'payroll',
    'Loans': 'loans',
    'Leaves': 'leaves',
    'Payslips': 'payslips'
}


def connect_url(user, password, host, port, dbname):
    return f"postgresql+psycopg2://{user}:{password}@{host}:{port}/{dbname}"


def run_schema_sql(engine, schema_path):
    if not os.path.exists(schema_path):
        print(f"schema.sql not found at {schema_path}, skipping DDL run.")
        return
    with open(schema_path, 'r', encoding='utf-8') as f:
        sql = f.read()
    with engine.begin() as conn:
        conn.execute(text(sql))
    print(i18n.t('schema_applied'))


def import_excel(file_path, engine):
    xls = pd.ExcelFile(file_path)
    print(i18n.t('found_sheets', sheets=', '.join(xls.sheet_names)))

    for sheet in xls.sheet_names:
        df = xls.parse(sheet)
        # drop empty rows/columns
        df = df.dropna(axis=0, how='all')
        df = df.loc[:, ~df.columns.str.contains('^Unnamed')]
        if df.shape[0] == 0:
            print(f"Sheet {sheet} is empty — skipping.")
            continue
        table_name = SHEET_TO_TABLE.get(sheet.strip(), sheet.strip().lower())
        print(i18n.t('importing_sheet', sheet=sheet, table=table_name, rows=df.shape[0]))
        # Use if_exists='replace' for first run; consider 'append' after cleaning
        df.to_sql(table_name, engine, if_exists='replace', index=False)
        print(i18n.t('imported_table', table=table_name))

    print('All sheets processed.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Import Excel HR system into PostgreSQL')
    parser.add_argument('--file', required=True, help='Path to Excel file')
    parser.add_argument('--dbuser', default=os.getenv('DB_USER', ''))
    parser.add_argument('--dbpass', default=os.getenv('DB_PASS', ''))
    parser.add_argument('--dbname', default=os.getenv('DB_NAME', ''))
    parser.add_argument('--host', default=os.getenv('DB_HOST', ''))
    parser.add_argument('--port', default=os.getenv('DB_PORT', ''))
    parser.add_argument('--schema', default='schema.sql', help='Path to schema SQL file')
    parser.add_argument('--lang', default='en', help='Language code: en or ar')

    args = parser.parse_args()

    # prefer .env values when present
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

    engine_url = connect_url(args.dbuser, args.dbpass, args.host, args.port, args.dbname)
    print('Connecting to DB at', engine_url)
    engine = create_engine(engine_url)

    # Apply schema (creates basic tables) — optional but helpful for constraints
    run_schema_sql(engine, args.schema)

    import_excel(args.file, engine)

    print('\nDone. Review tables in the database for correctness and refine data types as needed.')
