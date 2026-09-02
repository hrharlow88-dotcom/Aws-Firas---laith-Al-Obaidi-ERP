"""
Orchestration script: apply schema, import Excel, validate, export, generate payslips, init leaves, archive.

Usage example:
  python run_all.py --file Laith_Al-Obaidi_HR_System_2026.xlsx --year 2026 --month 8
"""

import argparse
import subprocess
import sys
import os
from pathlib import Path
import i18n


def run(cmd, check=True):
    print(i18n.t('running', cmd=' '.join(cmd)))
    res = subprocess.run(cmd, shell=False)
    if check and res.returncode != 0:
        print('Command failed:', cmd)
        sys.exit(res.returncode)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--file', required=True)
    parser.add_argument('--year', type=int, required=True)
    parser.add_argument('--month', type=int, required=True)
    parser.add_argument('--dbuser', default='hradmin')
    parser.add_argument('--dbpass', default='change_me_now')
    parser.add_argument('--dbname', default='hr_system')
    parser.add_argument('--host', default='localhost')
    parser.add_argument('--port', default='5432')
    parser.add_argument('--lang', default='')
    args = parser.parse_args()

    try:
        from dotenv import dotenv_values
        env = dotenv_values('.env') or {}
    except Exception:
        env = {}

    args.dbuser = env.get('DB_USER') or args.dbuser
    args.dbpass = env.get('DB_PASS') or args.dbpass
    args.dbname = env.get('DB_NAME') or args.dbname
    args.host = env.get('DB_HOST') or args.host
    args.port = env.get('DB_PORT') or args.port
    lang = env.get('LANG') or args.lang or 'en'

    i18n.set_language(lang)

    # 1) Apply schema
    run(['python', 'import_excel.py', '--file', args.file, '--dbuser', args.dbuser, '--dbpass', args.dbpass, '--dbname', args.dbname, '--host', args.host, '--port', args.port, '--schema', 'schema.sql', '--lang', args.lang])

    # 2) Validate
    run(['python', 'validate_data.py', '--year', str(args.year), '--month', str(args.month), '--dbuser', args.dbuser, '--dbpass', args.dbpass, '--dbname', args.dbname, '--host', args.host, '--port', args.port, '--lang', args.lang])

    # 3) Export tables
    run(['python', 'export_tables.py', '--tables', 'employees,payroll,loans', '--outdir', 'output/exports', '--dbuser', args.dbuser, '--dbpass', args.dbpass, '--dbname', args.dbname, '--host', args.host, '--port', args.port, '--lang', args.lang])

    # 4) Generate payslips
    run(['python', 'generate_payslips.py', '--year', str(args.year), '--month', str(args.month), '--outdir', 'output/payslips', '--dbuser', args.dbuser, '--dbpass', args.dbpass, '--dbname', args.dbname, '--host', args.host, '--port', args.port, '--lang', args.lang])

    # 5) Initialize leaves (for the year)
    run(['python', 'leave_manager.py', '--init', '--year', str(args.year), '--dbuser', args.dbuser, '--dbpass', args.dbpass, '--dbname', args.dbname, '--host', args.host, '--port', args.port, '--lang', args.lang])

    # 6) Archive month
    run(['python', 'archive_month.py', '--year', str(args.year), '--month', str(args.month), '--outdir', 'output/archives', '--dbuser', args.dbuser, '--dbpass', args.dbpass, '--dbname', args.dbname, '--host', args.host, '--port', args.port, '--lang', args.lang])

    print(i18n.t('all_steps_completed'))
