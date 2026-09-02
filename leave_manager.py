"""
Leaves management utilities.
- initialize opening balances (if not present)
- deduct leave usage
- compute remaining balances

Assumptions: 'leaves' table holds per-employee opening_balance and used for a year.
"""

import argparse
from sqlalchemy import create_engine, text
import os
import i18n


def connect_url(user, password, host, port, dbname):
    return f"postgresql+psycopg2://{user}:{password}@{host}:{port}/{dbname}"


def init_opening_balances(engine, year, default_days=21):
    # For employees without a leaves row for the year, insert a row with default opening balance
    with engine.begin() as conn:
        emp_ids = [r[0] for r in conn.execute(text('SELECT id FROM employees')).fetchall()]
        for eid in emp_ids:
            exists = conn.execute(text('SELECT 1 FROM leaves WHERE employee_id = :eid AND year = :y'), {'eid': eid, 'y': year}).fetchone()
            if not exists:
                conn.execute(text('INSERT INTO leaves (employee_id, leave_type, opening_balance, used, year) VALUES (:eid, :lt, :ob, 0, :y)'), {'eid': eid, 'lt': 'Annual', 'ob': default_days, 'y': year})
    print(i18n.t('opening_balances_initialized', days=default_days))


def deduct_leave(engine, employee_id, days, year):
    with engine.begin() as conn:
        row = conn.execute(text('SELECT opening_balance, used FROM leaves WHERE employee_id = :eid AND year = :y'), {'eid': employee_id, 'y': year}).fetchone()
        if not row:
            raise ValueError('No leave balance found for employee/year. Initialize first.')
        opening, used = row
        new_used = (used or 0) + days
        if new_used > (opening or 0):
            raise ValueError('Insufficient leave balance')
        conn.execute(text('UPDATE leaves SET used = :u WHERE employee_id = :eid AND year = :y'), {'u': new_used, 'eid': employee_id, 'y': year})
    print(i18n.t('deducted_leave', days=days, eid=employee_id, year=year))


def compute_remaining(engine, employee_id, year):
    with engine.connect() as conn:
        row = conn.execute(text('SELECT opening_balance, used FROM leaves WHERE employee_id = :eid AND year = :y'), {'eid': employee_id, 'y': year}).fetchone()
        if not row:
            return None
        opening, used = row
        return (opening or 0) - (used or 0)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--init', action='store_true', help='Initialize opening balances for all employees for the given year')
    parser.add_argument('--year', type=int, required=True)
    parser.add_argument('--employee', type=int, help='Employee ID for a deduction')
    parser.add_argument('--deduct', type=float, help='Days to deduct')
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
    if args.init:
        init_opening_balances(engine, args.year)
    elif args.employee and args.deduct:
        deduct_leave(engine, args.employee, args.deduct, args.year)
    elif args.employee:
        rem = compute_remaining(engine, args.employee, args.year)
        if rem is None:
            print(i18n.t('no_leave_record'))
        else:
            print(i18n.t('remaining_days', eid=args.employee, year=args.year, days=rem))
    else:
        print(i18n.t('no_action'))
