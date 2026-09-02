"""
Archive monthly data: export CSV snapshots for a given month/year and record an entry in monthly_archives.

Usage:
  python archive_month.py --year 2026 --month 8 --outdir output/archives
"""

import os
from pathlib import Path
import argparse
import pandas as pd
from sqlalchemy import create_engine, text
import i18n


def connect_url(user, password, host, port, dbname):
    return f"postgresql+psycopg2://{user}:{password}@{host}:{port}/{dbname}"


def export_snapshot(engine, year, month, outdir):
    outdir = Path(outdir) / f"{year}_{month:02d}"
    outdir.mkdir(parents=True, exist_ok=True)

    with engine.connect() as conn:
        # Export payroll rows for the month
        payroll = pd.read_sql(text('SELECT p.*, e.employee_code, e.first_name, e.last_name FROM payroll p LEFT JOIN employees e ON p.employee_id = e.id WHERE p.year = :y AND p.month = :m'), conn, params={'y': year, 'm': month})
        payroll.to_csv(outdir / 'payroll.csv', index=False)

        employees = pd.read_sql(text('SELECT * FROM employees'), conn)
        employees.to_csv(outdir / 'employees.csv', index=False)

        loans = pd.read_sql(text('SELECT * FROM loans'), conn)
        loans.to_csv(outdir / 'loans.csv', index=False)

    # Record archive metadata
    with engine.begin() as conn:
        conn.execute(text('INSERT INTO monthly_archives (archive_month, archive_year, note) VALUES (:m, :y, :n)'), {'m': month, 'y': year, 'n': f'Archive for {year}-{month:02d}'})

    print(i18n.t('archive_exported', outdir=str(outdir)))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--year', type=int, required=True)
    parser.add_argument('--month', type=int, required=True)
    parser.add_argument('--outdir', default='output/archives')
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
    export_snapshot(engine, args.year, args.month, args.outdir)
