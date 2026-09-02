"""
Generate PDF payslips for payroll records.
Requires: pandas, SQLAlchemy, reportlab

Usage:
  python generate_payslips.py --year 2026 --month 8 --outdir output/payslips
"""

import os
import argparse
from pathlib import Path
from sqlalchemy import create_engine, text
import pandas as pd
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm

import i18n


def connect_url(user, password, host, port, dbname):
    return f"postgresql+psycopg2://{user}:{password}@{host}:{port}/{dbname}"


def fetch_payroll(engine, year, month):
    q = text("SELECT p.*, e.employee_code, e.first_name, e.last_name, e.job_title FROM payroll p LEFT JOIN employees e ON p.employee_id = e.id WHERE p.year = :y AND p.month = :m")
    with engine.connect() as conn:
        df = pd.read_sql(q, conn, params={"y": year, "m": month})
    return df


def draw_payslip(pdf_path, row):
    c = canvas.Canvas(str(pdf_path), pagesize=A4)
    width, height = A4
    left = 20*mm
    top = height - 20*mm

    c.setFont("Helvetica-Bold", 14)
    c.drawString(left, top, i18n.t('payslip_title'))

    c.setFont("Helvetica", 10)
    y = top - 12*mm
    emp_name = f"{row.get('first_name','') or ''} {row.get('last_name','') or ''}".strip()
    c.drawString(left, y, i18n.t('employee_label', code=row.get('employee_code','') or '', name=emp_name))
    y -= 6*mm
    c.drawString(left, y, i18n.t('job_title', job=row.get('job_title','') or ''))
    y -= 6*mm
    c.drawString(left, y, i18n.t('period', month=int(row['month']), year=int(row['year'])))

    y -= 10*mm
    c.setFont("Helvetica-Bold", 11)
    c.drawString(left, y, i18n.t('earnings'))
    y -= 6*mm
    c.setFont("Helvetica", 10)
    c.drawString(left, y, i18n.t('gross', value=f"{row.get('gross', 0):,.2f}"))
    y -= 6*mm
    c.drawString(left, y, i18n.t('tax', value=f"{row.get('tax', 0):,.2f}"))
    y -= 6*mm
    c.drawString(left, y, i18n.t('deductions', value=f"{row.get('deductions', 0):,.2f}"))
    y -= 6*mm
    c.setFont("Helvetica-Bold", 11)
    c.drawString(left, y, i18n.t('net_pay', value=f"{row.get('net', 0):,.2f}"))

    y -= 15*mm
    c.setFont("Helvetica", 8)
    c.drawString(left, y, i18n.t('generated_by'))

    c.showPage()
    c.save()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--year', type=int, required=True)
    parser.add_argument('--month', type=int, required=True)
    parser.add_argument('--outdir', default='output/payslips')
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
    df = fetch_payroll(engine, args.year, args.month)

    outdir = Path(args.outdir) / f"{args.year}_{args.month:02d}"
    outdir.mkdir(parents=True, exist_ok=True)

    if df.shape[0] == 0:
        print(i18n.t('no_rows_month'))
    for _, row in df.iterrows():
        code = row.get('employee_code') or f"emp_{int(row.get('employee_id') or 0)}"
        pdf_path = outdir / f"{code}_{int(row['year'])}_{int(row['month'])}.pdf"
        draw_payslip(pdf_path, row)
        print(i18n.t('generated', path=str(pdf_path)))

    print(i18n.t('all_generated'))
