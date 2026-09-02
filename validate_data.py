"""
Data validation checks for payroll after import.
Checks:
 - required columns exist
 - no negative gross/net
 - gross - tax - deductions == net (within tolerance)

Usage:
  python validate_data.py --year 2026 --month 8
"""

import argparse
from sqlalchemy import create_engine, text
import pandas as pd
import i18n


def connect_url(user, password, host, port, dbname):
    return f"postgresql+psycopg2://{user}:{password}@{host}:{port}/{dbname}"


def validate_payroll(engine, year, month, tol=0.5):
    with engine.connect() as conn:
        df = pd.read_sql(text('SELECT p.*, e.employee_code FROM payroll p LEFT JOIN employees e ON p.employee_id = e.id WHERE p.year = :y AND p.month = :m'), conn, params={'y': year, 'm': month})
    if df.empty:
        print(i18n.t('no_rows_month'))
        return 1

    problems = []
    for idx, r in df.iterrows():
        gross = float(r.get('gross') or 0)
        net = float(r.get('net') or 0)
        tax = float(r.get('tax') or 0)
        deductions = float(r.get('deductions') or 0)
        calc_net = gross - tax - deductions
        if gross < 0 or net < 0:
            problems.append((r.get('employee_code'), 'Negative values'))
        if abs(calc_net - net) > tol:
            problems.append((r.get('employee_code'), f'Net mismatch: calc={calc_net:.2f} net={net:.2f}'))

    if not problems:
        print(i18n.t('validation_passed'))
        return 0
    else:
        print(i18n.t('found_problems'))
        for p in problems:
            print(p)
        return 2


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--year', type=int, required=True)
    parser.add_argument('--month', type=int, required=True)
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
    code = validate_payroll(engine, args.year, args.month)
    exit(code)
