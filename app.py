"""
Simple Flask web UI to control the HR system scripts.
Provides buttons to: import Excel, run full pipeline, generate payslips, init leaves, archive month, export tables.
Supports language via ?lang=ar or ?lang=en and passes to scripts.

Run: python app.py
"""
from flask import Flask, render_template, request, redirect, url_for, send_from_directory, session
import subprocess
from pathlib import Path
import os
import sqlite3
from datetime import datetime
from dotenv import dotenv_values

import i18n
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__)
app.secret_key = os.getenv('SECRET_KEY', 'hr-erp-demo-secret-key')
app.jinja_env.globals['i18n'] = i18n
app.jinja_env.globals['request'] = request
PROJECT_ROOT = Path(__file__).parent
ENV_PATH = PROJECT_ROOT / '.env'
ENV_EXAMPLE = PROJECT_ROOT / '.env.example'
OUTPUT_DIR = PROJECT_ROOT / 'output'
PAYS_DIR = OUTPUT_DIR / 'payslips'
EXCEL_FILE = PROJECT_ROOT / 'Laith_Al-Obaidi_HR_System_2026.xlsx'
DB_PATH = PROJECT_ROOT / 'hr_erp.db'


def get_company_settings():
    conn = get_db_connection()
    settings = conn.execute('SELECT * FROM company_settings ORDER BY id DESC LIMIT 1').fetchone()
    conn.close()
    if settings:
        return {
            'company_name': settings['company_name'],
            'company_email': settings['company_email'],
            'company_phone': settings['company_phone'],
            'currency': settings['currency'],
            'tax_rate': settings['tax_rate'],
            'address': settings['address'],
            'timezone': settings['timezone'],
        }
    return {
        'company_name': 'Al Obaidi ERP',
        'company_email': 'admin@company.com',
        'company_phone': '+964 770 000 0000',
        'currency': 'USD',
        'tax_rate': 15.0,
        'address': 'Baghdad, Iraq',
        'timezone': 'UTC+3',
    }


@app.context_processor
def inject_common():
    env_vals = read_env()
    lang = request.args.get('lang', env_vals.get('LANG', 'en'))
    i18n.set_language(lang)
    theme = {
        'APP_THEME_PRIMARY': env_vals.get('APP_THEME_PRIMARY', '#0b57d0'),
        'APP_THEME_SECONDARY': env_vals.get('APP_THEME_SECONDARY', '#0f172a'),
        'APP_THEME_ACCENT': env_vals.get('APP_THEME_ACCENT', '#22c55e'),
        'APP_THEME_SIDEBAR': env_vals.get('APP_THEME_SIDEBAR', 'linear-gradient(180deg, #0b1732 0%, #12254a 100%)')
    }
    company_settings = get_company_settings()
    return {
        'lang': lang,
        'site_title': i18n.t('portal_title'),
        'app_name': i18n.t('portal_title'),
        'session_user': session.get('user'),
        'theme': theme,
        'company_settings': company_settings,
    }


def run_script(cmd_list):
    try:
        res = subprocess.run(cmd_list, capture_output=True, text=True, cwd=str(PROJECT_ROOT))
        return res.returncode, res.stdout + "\n" + res.stderr
    except Exception as e:
        return 99, str(e)


def read_env():
    vals = {}
    if ENV_PATH.exists():
        vals = dotenv_values(str(ENV_PATH)) or {}
    elif ENV_EXAMPLE.exists():
        vals = dotenv_values(str(ENV_EXAMPLE)) or {}
    defaults = {
        'DB_HOST': 'localhost',
        'DB_PORT': '5432',
        'DB_NAME': 'hr_system',
        'DB_USER': 'hradmin',
        'DB_PASS': 'change_me_now',
        'LANG': 'en',
        'APP_THEME_PRIMARY': '#0b57d0',
        'APP_THEME_SECONDARY': '#0f172a',
        'APP_THEME_ACCENT': '#22c55e',
        'APP_THEME_SIDEBAR': 'linear-gradient(180deg, #0b1732 0%, #12254a 100%)'
    }
    for k, v in defaults.items():
        vals.setdefault(k, v)
    return vals


def write_env(values: dict):
    lines = []
    for k, v in values.items():
        val = str(v).replace('%', '%%')
        lines.append(f"{k}={val}")
    ENV_PATH.write_text('\n'.join(lines), encoding='utf-8')


def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db_connection()
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT,
            full_name TEXT,
            role TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS employees (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_code TEXT UNIQUE,
            first_name TEXT,
            last_name TEXT,
            department TEXT,
            job_title TEXT,
            email TEXT,
            phone TEXT,
            hire_date TEXT,
            base_salary REAL,
            status TEXT DEFAULT 'Active',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS payroll_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_code TEXT,
            employee_name TEXT,
            period TEXT,
            gross REAL,
            deductions REAL,
            net REAL,
            status TEXT DEFAULT 'Approved',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS leave_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_code TEXT,
            employee_name TEXT,
            leave_type TEXT,
            days REAL,
            year INTEGER,
            status TEXT DEFAULT 'Approved',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS attendance_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_code TEXT,
            employee_name TEXT,
            attendance_date TEXT,
            check_in TEXT,
            check_out TEXT,
            status TEXT DEFAULT 'Present',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS accounting_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            journal TEXT,
            account_code TEXT,
            account_name TEXT,
            debit REAL,
            credit REAL,
            memo TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS chart_of_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_code TEXT UNIQUE,
            account_name TEXT,
            account_type TEXT,
            normal_balance TEXT,
            description TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS journal_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entry_no TEXT UNIQUE,
            entry_date TEXT,
            description TEXT,
            total_debit REAL,
            total_credit REAL,
            status TEXT DEFAULT 'Posted',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS journal_entry_lines (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entry_id INTEGER,
            account_code TEXT,
            account_name TEXT,
            debit REAL,
            credit REAL,
            memo TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS finance_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT,
            category TEXT,
            description TEXT,
            amount REAL,
            reference TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS company_settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_name TEXT,
            company_email TEXT,
            company_phone TEXT,
            currency TEXT,
            tax_rate REAL,
            address TEXT,
            timezone TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        -- Companies and branches
        CREATE TABLE IF NOT EXISTS companies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            registration_no TEXT,
            address TEXT,
            phone TEXT,
            email TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS branches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            name TEXT,
            address TEXT,
            phone TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        -- RBAC: roles and permissions
        CREATE TABLE IF NOT EXISTS roles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            description TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS permissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE,
            description TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS user_roles (
            user_id INTEGER,
            role_id INTEGER,
            PRIMARY KEY (user_id, role_id)
        );

        CREATE TABLE IF NOT EXISTS role_permissions (
            role_id INTEGER,
            permission_id INTEGER,
            PRIMARY KEY (role_id, permission_id)
        );

        CREATE TABLE IF NOT EXISTS sales_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_no TEXT,
            customer_name TEXT,
            customer_email TEXT,
            sales_date TEXT,
            total REAL,
            tax REAL,
            status TEXT DEFAULT 'Draft',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS customers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_name TEXT,
            company TEXT,
            email TEXT,
            phone TEXT,
            segment TEXT,
            status TEXT DEFAULT 'Active',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS suppliers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            supplier_name TEXT,
            contact_name TEXT,
            email TEXT,
            phone TEXT,
            category TEXT,
            status TEXT DEFAULT 'Active',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS inventory_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_name TEXT,
            category TEXT,
            sku TEXT,
            quantity REAL,
            unit_cost REAL,
            reorder_level REAL,
            warehouse TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS purchase_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_no TEXT,
            supplier_name TEXT,
            item_name TEXT,
            quantity REAL,
            unit_cost REAL,
            total REAL,
            status TEXT DEFAULT 'Pending',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
    ''')

    cur = conn.cursor()

    # Ensure company_id column exists on important tables (SQLite: add column if missing)
    tables_to_update = ['employees','payroll_runs','leave_records','attendance_records','accounting_entries','chart_of_accounts','journal_entries','journal_entry_lines','finance_transactions','sales_orders','customers','suppliers','inventory_items','purchase_orders']
    for t in tables_to_update:
        try:
            cols = [r[1] for r in conn.execute(f"PRAGMA table_info({t})").fetchall()]
            if 'company_id' not in cols:
                conn.execute(f'ALTER TABLE {t} ADD COLUMN company_id INTEGER')
        except Exception:
            # table may not exist yet; ignore
            pass

    # Migrate plaintext passwords: re-hash any passwords that don't look hashed
    try:
        users_rows = cur.execute('SELECT id, password FROM users').fetchall()
        for u in users_rows:
            pw = u['password']
            if pw and not (pw.startswith('pbkdf2:') or pw.startswith('bcrypt:') or ':' in pw or '$' in pw) :
                newhash = generate_password_hash(pw)
                cur.execute('UPDATE users SET password = ? WHERE id = ?', (newhash, u['id']))
    except Exception:
        # users table may not exist yet
        pass

    conn.commit()

    if cur.execute('SELECT COUNT(*) FROM users').fetchone()[0] == 0:
        hashed = generate_password_hash('admin123')
        cur.execute(
            'INSERT INTO users (username, password, full_name, role) VALUES (?, ?, ?, ?)',
            ('admin', hashed, 'System Administrator', 'admin')
        )
    # Seed roles & permissions
    if cur.execute('SELECT COUNT(*) FROM roles').fetchone()[0] == 0:
        cur.executemany(
            'INSERT INTO roles (name, description) VALUES (?, ?)',
            [
                ('admin', 'Full administrator'),
                ('accountant', 'Accounting user'),
                ('hr', 'Human resources'),
                ('sales', 'Sales user'),
                ('inventory', 'Inventory manager')
            ]
        )
    if cur.execute('SELECT COUNT(*) FROM permissions').fetchone()[0] == 0:
        cur.executemany(
            'INSERT INTO permissions (code, description) VALUES (?, ?)',
            [
                ('manage_users', 'Manage users and roles'),
                ('manage_companies', 'Manage companies and branches'),
                ('post_journal', 'Post journal entries'),
                ('view_reports', 'View financial reports')
            ]
        )
    # assign admin role to admin user
    admin_id = cur.execute("SELECT id FROM users WHERE username = 'admin'").fetchone()[0]
    admin_role_id = cur.execute("SELECT id FROM roles WHERE name = 'admin'").fetchone()[0]
    cur.execute('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', (admin_id, admin_role_id))
    # give admin role all permissions
    perm_rows = cur.execute('SELECT id FROM permissions').fetchall()
    for p in perm_rows:
        cur.execute('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', (admin_role_id, p['id']))

    # seed a default company if none exists
    if cur.execute('SELECT COUNT(*) FROM companies').fetchone()[0] == 0:
        cur.execute('INSERT INTO companies (name, registration_no, address, phone, email) VALUES (?, ?, ?, ?, ?)',
                    ('Al Obaidi ERP Group', 'REG-0001', 'Baghdad, Iraq', '+9647700000000', 'admin@alobaidi-erp.com'))
        cur.execute('INSERT INTO branches (company_id, name, address, phone) VALUES (?, ?, ?, ?)', (1, 'Head Office', 'Baghdad', '+9647700000000'))

    if cur.execute('SELECT COUNT(*) FROM employees').fetchone()[0] == 0:
        employee_rows = [
            ( 'E-1001', 'Ahmed', 'Ali', 'HR', 'HR Manager', 'ahmed.ali@company.com', '+9647700000001', '2024-01-15', 3200.00, 1),
            ( 'E-1002', 'Nora', 'Salem', 'Finance', 'Finance Analyst', 'nora.salem@company.com', '+9647700000002', '2023-02-20', 2900.00, 1),
            ( 'E-1003', 'Yasmin', 'Hassan', 'Operations', 'Operations Lead', 'yasmin.hassan@company.com', '+9647700000003', '2022-06-10', 3550.00, 1),
            ( 'E-1004', 'Firas', 'Obaidi', 'IT', 'System Administrator', 'firas.obaidi@company.com', '+9647700000004', '2021-11-30', 4200.00, 1),
            ( 'E-1005', 'Layla', 'Mahmoud', 'Sales', 'Sales Executive', 'layla.mahmoud@company.com', '+9647700000005', '2024-08-01', 2500.00, 1),
        ]
        cur.executemany(
            'INSERT INTO employees (employee_code, first_name, last_name, department, job_title, email, phone, hire_date, base_salary, company_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            employee_rows
        )
    if cur.execute('SELECT COUNT(*) FROM payroll_runs').fetchone()[0] == 0:
        cur.executemany(
            'INSERT INTO payroll_runs (employee_code, employee_name, period, gross, deductions, net, status, company_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [
                ('E-1001', 'Ahmed Ali', '2026-08', 3200.00, 180.00, 3020.00, 'Approved', 1),
                ('E-1002', 'Nora Salem', '2026-08', 2900.00, 212.00, 2688.00, 'Approved', 1),
                ('E-1003', 'Yasmin Hassan', '2026-08', 3550.00, 260.00, 3290.00, 'Approved', 1),
                ('E-1004', 'Firas Obaidi', '2026-08', 4200.00, 348.00, 3852.00, 'Pending', 1),
            ]
        )
    if cur.execute('SELECT COUNT(*) FROM leave_records').fetchone()[0] == 0:
        cur.executemany(
            'INSERT INTO leave_records (employee_code, employee_name, leave_type, days, year, status, company_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [
                ('E-1001', 'Ahmed Ali', 'Annual', 16.0, 2026, 'Approved', 1),
                ('E-1002', 'Nora Salem', 'Sick', 6.0, 2026, 'Approved', 1),
                ('E-1003', 'Yasmin Hassan', 'Casual', 10.0, 2026, 'Pending', 1),
            ]
        )
    if cur.execute('SELECT COUNT(*) FROM attendance_records').fetchone()[0] == 0:
        cur.executemany(
            'INSERT INTO attendance_records (employee_code, employee_name, attendance_date, check_in, check_out, status, company_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [
                ('E-1001', 'Ahmed Ali', '2026-08-24', '08:30', '17:00', 'Present', 1),
                ('E-1002', 'Nora Salem', '2026-08-24', '08:45', '16:45', 'Present', 1),
                ('E-1003', 'Yasmin Hassan', '2026-08-24', '09:15', '17:30', 'Late', 1),
                ('E-1004', 'Firas Obaidi', '2026-08-24', '08:20', '17:10', 'Present', 1),
            ]
        )
    if cur.execute('SELECT COUNT(*) FROM accounting_entries').fetchone()[0] == 0:
        cur.executemany(
            'INSERT INTO accounting_entries (journal, account_code, account_name, debit, credit, memo, company_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [
                ('JV-001', '1010', 'Cash', 60000.00, 0.00, 'Initial capital', 1),
                ('JV-001', '4000', 'Sales Revenue', 0.00, 60000.00, 'Revenue received from operations', 1),
                ('JV-002', '5000', 'Payroll Expense', 36000.00, 0.00, 'August payroll expense', 1),
                ('JV-002', '1010', 'Cash', 0.00, 36000.00, 'August payroll expense', 1),
            ]
        )
    if cur.execute('SELECT COUNT(*) FROM chart_of_accounts').fetchone()[0] == 0:
        cur.executemany(
            'INSERT INTO chart_of_accounts (account_code, account_name, account_type, normal_balance, description, company_id) VALUES (?, ?, ?, ?, ?, ?)',
            [
                ('1010', 'Cash', 'Asset', 'Debit', 'Cash in hand and bank', 1),
                ('1100', 'Accounts Receivable', 'Asset', 'Debit', 'Amounts due from customers', 1),
                ('2000', 'Accounts Payable', 'Liability', 'Credit', 'Amounts due to suppliers', 1),
                ('3000', 'Owner Equity', 'Equity', 'Credit', 'Capital and retained earnings', 1),
                ('4000', 'Sales Revenue', 'Revenue', 'Credit', 'Income from sales', 1),
                ('5000', 'Payroll Expense', 'Expense', 'Debit', 'Staff payroll cost', 1),
                ('5100', 'Office Expense', 'Expense', 'Debit', 'General office costs', 1),
            ]
        )
    if cur.execute('SELECT COUNT(*) FROM journal_entries').fetchone()[0] == 0:
        cur.executemany(
            'INSERT INTO journal_entries (entry_no, entry_date, description, total_debit, total_credit, status, company_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [
                ('JV-001', '2026-08-05', 'Revenue booking from operations', 60000.00, 60000.00, 'Posted', 1),
                ('JV-002', '2026-08-12', 'Payroll expense settlement', 36000.00, 36000.00, 'Posted', 1),
            ]
        )
    if cur.execute('SELECT COUNT(*) FROM journal_entry_lines').fetchone()[0] == 0:
        cur.executemany(
            'INSERT INTO journal_entry_lines (entry_id, account_code, account_name, debit, credit, memo, company_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [
                (1, '1010', 'Cash', 60000.00, 0.00, 'Revenue received from operations', 1),
                (1, '4000', 'Sales Revenue', 0.00, 60000.00, 'Revenue received from operations', 1),
                (2, '5000', 'Payroll Expense', 36000.00, 0.00, 'August payroll expense', 1),
                (2, '1010', 'Cash', 0.00, 36000.00, 'August payroll expense', 1),
            ]
        )
    if cur.execute('SELECT COUNT(*) FROM finance_transactions').fetchone()[0] == 0:
        cur.executemany(
            'INSERT INTO finance_transactions (type, category, description, amount, reference, company_id) VALUES (?, ?, ?, ?, ?, ?)',
            [
                ('income', 'Revenue', 'Monthly service revenue', 58000.00, 'REV-001', 1),
                ('expense', 'Payroll', 'August payroll disbursement', -36000.00, 'PAY-008', 1),
                ('expense', 'Operations', 'Office and telecoms', -4200.00, 'OPS-011', 1),
                ('income', 'Loan Collection', 'Employee loan recovery', 1800.00, 'LOAN-045', 1),
            ]
        )
    if cur.execute('SELECT COUNT(*) FROM company_settings').fetchone()[0] == 0:
        cur.execute(
            'INSERT INTO company_settings (company_name, company_email, company_phone, currency, tax_rate, address, timezone) VALUES (?, ?, ?, ?, ?, ?, ?)',
            ('Al Obaidi ERP Group', 'admin@alobaidi-erp.com', '+964 770 000 0000', 'USD', 15.0, 'Baghdad, Iraq', 'UTC+3')
        )
    if cur.execute('SELECT COUNT(*) FROM sales_orders').fetchone()[0] == 0:
        cur.executemany(
            'INSERT INTO sales_orders (order_no, customer_name, customer_email, sales_date, total, tax, status, company_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [
                ('SO-1001', 'Ali Rahman', 'ali@rahmanlog.com', '2026-08-10', 4200.00, 630.00, 'Paid', 1),
                ('SO-1002', 'Safa Noor', 'safa@noorprop.com', '2026-08-14', 6100.00, 915.00, 'Confirmed', 1),
                ('SO-1003', 'Hassan Kareem', 'hassan@kareemtrade.com', '2026-08-18', 2800.00, 420.00, 'Draft', 1),
            ]
        )
    if cur.execute('SELECT COUNT(*) FROM customers').fetchone()[0] == 0:
        cur.executemany(
            'INSERT INTO customers (customer_name, company, email, phone, segment, status, company_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [
                ('Ali Rahman', 'Rahman Logistics', 'ali@rahmanlog.com', '+9647701234567', 'Corporate', 'Active', 1),
                ('Safa Noor', 'Noor Properties', 'safa@noorprop.com', '+9647701234568', 'Enterprise', 'Active', 1),
                ('Hassan Kareem', 'Kareem Trade', 'hassan@kareemtrade.com', '+9647701234569', 'SME', 'Lead', 1),
            ]
        )
    if cur.execute('SELECT COUNT(*) FROM suppliers').fetchone()[0] == 0:
        cur.executemany(
            'INSERT INTO suppliers (supplier_name, contact_name, email, phone, category, status, company_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [
                ('Iraq Office Supply', 'Nabil Salim', 'nabil@officeiraq.com', '+9647702345678', 'Office', 'Active', 1),
                ('Fast Logistics Co', 'Layla Taha', 'layla@fastlog.com', '+9647702345679', 'Transport', 'Active', 1),
                ('Prime Tech Devices', 'Samir Ali', 'samir@primetech.com', '+9647702345680', 'IT', 'Active', 1),
            ]
        )
    if cur.execute('SELECT COUNT(*) FROM inventory_items').fetchone()[0] == 0:
        cur.executemany(
            'INSERT INTO inventory_items (item_name, category, sku, quantity, unit_cost, reorder_level, warehouse, company_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [
                ('Laptop Dell 14', 'IT', 'IT-001', 18.0, 950.00, 5.0, 'Main Warehouse', 1),
                ('Office Chair', 'Furniture', 'FUR-012', 42.0, 180.00, 10.0, 'HQ Storage', 1),
                ('Printer Cartridge', 'Stationery', 'ST-200', 32.0, 42.00, 12.0, 'Support Store', 1),
            ]
        )
    if cur.execute('SELECT COUNT(*) FROM purchase_orders').fetchone()[0] == 0:
        cur.executemany(
            'INSERT INTO purchase_orders (order_no, supplier_name, item_name, quantity, unit_cost, total, status, company_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [
                ('PO-1001', 'Iraq Office Supply', 'Office Chair', 12, 180.00, 2160.00, 'Approved', 1),
                ('PO-1002', 'Prime Tech Devices', 'Laptop Dell 14', 8, 950.00, 7600.00, 'Pending', 1),
                ('PO-1003', 'Fast Logistics Co', 'Printer Cartridge', 25, 42.00, 1050.00, 'Completed', 1),
            ]
        )
    conn.commit()
    conn.close()


def get_current_user():
    u = session.get('user')
    if not u:
        return None
    conn = get_db_connection()
    user = conn.execute('SELECT * FROM users WHERE username = ?', (u.get('username'),)).fetchone()
    conn.close()
    return user


def has_permission(permission_code: str) -> bool:
    user = get_current_user()
    if not user:
        return False
    conn = get_db_connection()
    # check roles of user and role_permissions
    rows = conn.execute(
        '''
        SELECT 1 FROM user_roles ur
        JOIN role_permissions rp ON ur.role_id = rp.role_id
        JOIN permissions p ON rp.permission_id = p.id
        WHERE ur.user_id = ? AND p.code = ?
        ''',
        (user['id'], permission_code)
    ).fetchone()
    conn.close()
    return bool(rows)


def authentication_required(fn):
    def wrapper(*args, **kwargs):
        if not session.get('user'):
            return redirect(url_for('login'))
        return fn(*args, **kwargs)
    wrapper.__name__ = fn.__name__
    return wrapper


def get_active_company_id():
# return the company_id selected in session, otherwise fallback to first company id
try:
    cid = session.get('company_id')
    if cid:
        return int(cid)
except Exception:
    pass
conn = get_db_connection()
row = conn.execute('SELECT id FROM companies ORDER BY id LIMIT 1').fetchone()
conn.close()
return row['id'] if row else None


def permission_required(permission_code):
def deco(fn):
    def wrapper(*args, **kwargs):
        if not has_permission(permission_code):
            return render_template('result.html', title='Forbidden', output='Permission denied', lang=request.args.get('lang','en'))
        return fn(*args, **kwargs)
    wrapper.__name__ = fn.__name__
    return wrapper
return deco


@app.route('/login', methods=['GET', 'POST'])
def login():
    lang = request.args.get('lang', 'en')
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '').strip()
        conn = get_db_connection()
        user = conn.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
        conn.close()
        if user and check_password_hash(user['password'], password):
            session['user'] = {'username': user['username'], 'full_name': user['full_name'], 'role': user['role']}
            return redirect(url_for('index', lang=lang))
        return render_template('login.html', lang=lang, error='Invalid username or password.', show_error=True)
    return render_template('login.html', lang=lang)


# Admin routes: Users, Roles, Companies
@app.route('/admin/users', methods=['GET', 'POST'])
@authentication_required
@permission_required('manage_users')
def admin_users():
    lang = request.args.get('lang', 'en')
    conn = get_db_connection()
    cur = conn.cursor()
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '').strip()
        full_name = request.form.get('full_name', '').strip()
        role_id = request.form.get('role_id')
        if username and password:
            hashed = generate_password_hash(password)
            cur.execute('INSERT INTO users (username, password, full_name) VALUES (?, ?, ?)', (username, hashed, full_name))
            user_id = cur.lastrowid
            if role_id:
                cur.execute('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', (user_id, int(role_id)))
            conn.commit()
        return redirect(url_for('admin_users', lang=lang))

    users = conn.execute('SELECT u.*, GROUP_CONCAT(r.name) AS roles FROM users u LEFT JOIN user_roles ur ON u.id=ur.user_id LEFT JOIN roles r ON ur.role_id=r.id GROUP BY u.id ORDER BY u.id DESC').fetchall()
    roles = conn.execute('SELECT * FROM roles ORDER BY name').fetchall()
    conn.close()
    return render_template('admin_users.html', users=users, roles=roles, lang=lang)


@app.route('/admin/roles', methods=['GET', 'POST'])
@authentication_required
@permission_required('manage_users')
def admin_roles():
    lang = request.args.get('lang', 'en')
    conn = get_db_connection()
    cur = conn.cursor()
    if request.method == 'POST':
        name = request.form.get('name', '').strip()
        description = request.form.get('description', '').strip()
        perm_ids = request.form.getlist('permissions')
        if name:
            cur.execute('INSERT OR IGNORE INTO roles (name, description) VALUES (?, ?)', (name, description))
            conn.commit()
            role = cur.execute('SELECT id FROM roles WHERE name = ?', (name,)).fetchone()
            if role:
                for pid in perm_ids:
                    cur.execute('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', (role['id'], int(pid)))
                conn.commit()
        return redirect(url_for('admin_roles', lang=lang))

    roles = conn.execute('SELECT * FROM roles ORDER BY name').fetchall()
    permissions = conn.execute('SELECT * FROM permissions ORDER BY code').fetchall()
    conn.close()
    return render_template('admin_roles.html', roles=roles, permissions=permissions, lang=lang)


@app.route('/admin/companies', methods=['GET', 'POST'])
@authentication_required
@permission_required('manage_companies')
def admin_companies():
    lang = request.args.get('lang', 'en')
    conn = get_db_connection()
    cur = conn.cursor()
    if request.method == 'POST':
        name = request.form.get('name', '').strip()
        registration_no = request.form.get('registration_no', '').strip()
        address = request.form.get('address', '').strip()
        phone = request.form.get('phone', '').strip()
        email = request.form.get('email', '').strip()
        if name:
            cur.execute('INSERT INTO companies (name, registration_no, address, phone, email) VALUES (?, ?, ?, ?, ?)', (name, registration_no, address, phone, email))
            conn.commit()
        return redirect(url_for('admin_companies', lang=lang))

    companies = conn.execute('SELECT * FROM companies ORDER BY id DESC').fetchall()
    branches = conn.execute('SELECT b.*, c.name as company_name FROM branches b LEFT JOIN companies c ON b.company_id = c.id ORDER BY b.id DESC').fetchall()
    conn.close()
    return render_template('admin_companies.html', companies=companies, branches=branches, lang=lang)


@app.route('/logout')
def logout():
    session.pop('user', None)
    return redirect(url_for('login', lang=request.args.get('lang', 'en')))


@app.route('/')
@app.route('/portal')
def index():
    lang = request.args.get('lang', 'en')
    i18n.set_language(lang)
    return render_template('index.html', lang=lang)


@app.route('/dashboard')
def dashboard():
    return redirect(url_for('index', lang=request.args.get('lang', 'en')))


@app.route('/health')
def health():
    return {
        'status': 'ok',
        'service': 'hr-erp-portal',
        'language': request.args.get('lang', read_env().get('LANG', 'en')),
        'project_root': str(PROJECT_ROOT)
    }


@app.route('/employees', methods=['GET', 'POST'])
def employees():
    lang = request.args.get('lang', 'en')
    conn = get_db_connection()
    cid = get_active_company_id()
    if request.method == 'POST':
        employee_code = request.form.get('employee_code', '').strip()
        first_name = request.form.get('first_name', '').strip()
        last_name = request.form.get('last_name', '').strip()
        department = request.form.get('department', '').strip()
        job_title = request.form.get('job_title', '').strip()
        email = request.form.get('email', '').strip()
        phone = request.form.get('phone', '').strip()
        hire_date = request.form.get('hire_date', '')
        base_salary = float(request.form.get('base_salary', '0') or 0)
        if employee_code and first_name and last_name:
            conn.execute(
                '''
                INSERT INTO employees (employee_code, first_name, last_name, department, job_title, email, phone, hire_date, base_salary, company_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''',
                (employee_code, first_name, last_name, department, job_title, email, phone, hire_date, base_salary, cid)
            )
            conn.commit()
        conn.close()
        return redirect(url_for('employees', lang=lang))

    search = (request.args.get('search') or '').strip()
    department = (request.args.get('department') or '').strip()
    status = (request.args.get('status') or '').strip()
    query = 'SELECT * FROM employees WHERE 1=1'
    params = []
    if search:
        query += ' AND (first_name LIKE ? OR last_name LIKE ? OR employee_code LIKE ? OR department LIKE ?)'
        term = f'%{search}%'
        params.extend([term, term, term, term])
    if department:
        query += ' AND department = ?'
        params.append(department)
    if status:
        query += ' AND status = ?'
        params.append(status)
    if cid:
        query += ' AND (company_id = ? OR company_id IS NULL)'
        params.append(cid)
    query += ' ORDER BY id DESC'
    employees_data = conn.execute(query, params).fetchall()
    summary = conn.execute('SELECT COUNT(*) AS total, ROUND(AVG(base_salary), 2) AS avg_salary, SUM(base_salary) AS total_salary FROM employees' + (" WHERE company_id = ? OR company_id IS NULL" if cid else ''), (cid,) if cid else () ).fetchone()
    departments = conn.execute('SELECT DISTINCT department FROM employees WHERE department IS NOT NULL AND department != ""' + (" AND (company_id = ? OR company_id IS NULL)" if cid else '') + ' ORDER BY department', (cid,) if cid else () ).fetchall()
    conn.close()
    return render_template('employees.html', lang=lang, employees=employees_data, summary=summary, departments=departments, search=search, department=department, status=status)


@app.route('/payroll', methods=['GET', 'POST'])
def payroll():
    lang = request.args.get('lang', 'en')
    conn = get_db_connection()
    if request.method == 'POST':
        employee_code = request.form.get('employee_code', '').strip()
        employee_name = request.form.get('employee_name', '').strip()
        period = request.form.get('period', '')
        gross = float(request.form.get('gross', '0') or 0)
        deductions = float(request.form.get('deductions', '0') or 0)
        net = float(request.form.get('net', '0') or 0)
        status = request.form.get('status', 'Approved')
        if employee_code and employee_name and period:
            conn.execute(
                'INSERT INTO payroll_runs (employee_code, employee_name, period, gross, deductions, net, status, company_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                (employee_code, employee_name, period, gross, deductions, net, status, get_active_company_id())
            )
            conn.commit()
        conn.close()
        return redirect(url_for('payroll', lang=lang))
    cid = get_active_company_id()
    rows = conn.execute('SELECT * FROM payroll_runs' + (' WHERE company_id = ? OR company_id IS NULL' if cid else '') + ' ORDER BY id DESC', (cid,) if cid else () ).fetchall()
    summary = conn.execute('SELECT COUNT(*) AS record_count, ROUND(SUM(gross), 2) AS total_gross, ROUND(SUM(net), 2) AS total_net FROM payroll_runs' + (' WHERE company_id = ? OR company_id IS NULL' if cid else ''), (cid,) if cid else () ).fetchone()
    conn.close()
    return render_template('payroll.html', lang=lang, payroll=rows, summary=summary)


@app.route('/finance', methods=['GET', 'POST'])
def finance():
    lang = request.args.get('lang', 'en')
    conn = get_db_connection()
    if request.method == 'POST':
        tx_type = request.form.get('type', 'income')
        category = request.form.get('category', '').strip()
        description = request.form.get('description', '').strip()
        amount = float(request.form.get('amount', '0') or 0)
        reference = request.form.get('reference', '').strip()
        if category and description:
            conn.execute(
                'INSERT INTO finance_transactions (type, category, description, amount, reference, company_id) VALUES (?, ?, ?, ?, ?, ?)',
                (tx_type, category, description, amount, reference, get_active_company_id())
            )
            conn.commit()
        conn.close()
        return redirect(url_for('finance', lang=lang))
    cid = get_active_company_id()
    rows = conn.execute('SELECT * FROM finance_transactions' + (' WHERE company_id = ?' if cid else '') + ' ORDER BY id DESC', (cid,) if cid else () ).fetchall()
    summary = conn.execute('SELECT SUM(amount) AS balance, SUM(CASE WHEN amount >= 0 THEN amount ELSE 0 END) AS income, SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) AS expense FROM finance_transactions' + (' WHERE company_id = ?' if cid else ''), (cid,) if cid else () ).fetchone()
    conn.close()
    return render_template('finance.html', lang=lang, transactions=rows, summary=summary)


@app.route('/reports')
def reports():
    lang = request.args.get('lang', 'en')
    conn = get_db_connection()
    cid = get_active_company_id()
    employee_count = conn.execute('SELECT COUNT(*) FROM employees' + (' WHERE company_id = ? OR company_id IS NULL' if cid else ''), (cid,) if cid else () ).fetchone()[0]
    payroll_total = conn.execute('SELECT ROUND(SUM(net), 2) FROM payroll_runs' + (' WHERE company_id = ? OR company_id IS NULL' if cid else ''), (cid,) if cid else () ).fetchone()[0] or 0
    finance_total = conn.execute('SELECT ROUND(SUM(amount), 2) FROM finance_transactions' + (' WHERE company_id = ?' if cid else ''), (cid,) if cid else () ).fetchone()[0] or 0
    leave_total = conn.execute('SELECT ROUND(SUM(days), 2) FROM leave_records' + (' WHERE company_id = ? OR company_id IS NULL' if cid else ''), (cid,) if cid else () ).fetchone()[0] or 0
    sales_total = conn.execute('SELECT ROUND(SUM(total), 2) FROM sales_orders' + (' WHERE company_id = ?' if cid else ''), (cid,) if cid else () ).fetchone()[0] or 0
    transactions = conn.execute('SELECT * FROM finance_transactions' + (' WHERE company_id = ?' if cid else '') + ' ORDER BY id DESC LIMIT 5', (cid,) if cid else () ).fetchall()
    conn.close()
    report_cards = [
        {'label': 'Employees', 'value': employee_count},
        {'label': 'Net Payroll', 'value': f'${payroll_total:,.2f}'},
        {'label': 'Finance Balance', 'value': f'${finance_total:,.2f}'},
        {'label': 'Leave Days', 'value': leave_total},
        {'label': 'Sales Orders', 'value': f'${sales_total:,.2f}'},
    ]
    return render_template('reports.html', lang=lang, report_cards=report_cards, transactions=transactions)


@app.route('/sales', methods=['GET', 'POST'])
def sales():
    lang = request.args.get('lang', 'en')
    conn = get_db_connection()
    if request.method == 'POST':
        order_no = request.form.get('order_no', '').strip()
        customer_name = request.form.get('customer_name', '').strip()
        customer_email = request.form.get('customer_email', '').strip()
        sales_date = request.form.get('sales_date', '')
        total = float(request.form.get('total', '0') or 0)
        tax = float(request.form.get('tax', '0') or 0)
        status = request.form.get('status', 'Draft')
        if order_no and customer_name:
            conn.execute(
                'INSERT INTO sales_orders (order_no, customer_name, customer_email, sales_date, total, tax, status, company_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                (order_no, customer_name, customer_email, sales_date, total, tax, status, get_active_company_id())
            )
            conn.commit()
        conn.close()
        return redirect(url_for('sales', lang=lang))
    cid = get_active_company_id()
    rows = conn.execute('SELECT * FROM sales_orders' + (' WHERE company_id = ?' if cid else '') + ' ORDER BY id DESC', (cid,) if cid else () ).fetchall()
    summary = conn.execute('SELECT COUNT(*) AS total_orders, ROUND(SUM(total), 2) AS sales_value, ROUND(SUM(tax), 2) AS taxes FROM sales_orders' + (' WHERE company_id = ?' if cid else ''), (cid,) if cid else () ).fetchone()
    conn.close()
    return render_template('sales.html', lang=lang, sales=rows, summary=summary)


@app.route('/attendance', methods=['GET', 'POST'])
def attendance():
    lang = request.args.get('lang', 'en')
    conn = get_db_connection()
    if request.method == 'POST':
        employee_code = request.form.get('employee_code', '').strip()
        employee_name = request.form.get('employee_name', '').strip()
        attendance_date = request.form.get('attendance_date', '')
        check_in = request.form.get('check_in', '')
        check_out = request.form.get('check_out', '')
        status = request.form.get('status', 'Present')
        if employee_code and employee_name and attendance_date:
            conn.execute(
                    'INSERT INTO attendance_records (employee_code, employee_name, attendance_date, check_in, check_out, status, company_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    (employee_code, employee_name, attendance_date, check_in, check_out, status, get_active_company_id())
            )
            conn.commit()
        conn.close()
        return redirect(url_for('attendance', lang=lang))

    rows = conn.execute('SELECT * FROM attendance_records ORDER BY id DESC').fetchall()
    summary = conn.execute('SELECT COUNT(*) AS total_records, SUM(CASE WHEN status = "Present" THEN 1 ELSE 0 END) AS present_count, SUM(CASE WHEN status = "Late" THEN 1 ELSE 0 END) AS late_count, SUM(CASE WHEN status = "Absent" THEN 1 ELSE 0 END) AS absent_count FROM attendance_records').fetchone()
    conn.close()
    return render_template('attendance.html', lang=lang, attendances=rows, summary=summary)


@app.route('/leaves', methods=['GET', 'POST'])
def leaves():
    lang = request.args.get('lang', 'en')
    conn = get_db_connection()
    if request.method == 'POST':
        employee_code = request.form.get('employee_code', '').strip()
        employee_name = request.form.get('employee_name', '').strip()
        leave_type = request.form.get('leave_type', '').strip()
        days = float(request.form.get('days', '0') or 0)
        year = int(request.form.get('year', '2026') or 2026)
        status = request.form.get('status', 'Pending')
        if employee_code and employee_name:
            conn.execute(
                'INSERT INTO leave_records (employee_code, employee_name, leave_type, days, year, status) VALUES (?, ?, ?, ?, ?, ?)',
                (employee_code, employee_name, leave_type, days, year, status)
            )
            conn.commit()
        conn.close()
        return redirect(url_for('leaves', lang=lang))
    rows = conn.execute('SELECT * FROM leave_records ORDER BY id DESC').fetchall()
    summary = conn.execute('SELECT SUM(days) AS total_days, COUNT(*) AS total_requests FROM leave_records').fetchone()
    conn.close()
    return render_template('leaves.html', lang=lang, leaves=rows, summary=summary)


@app.route('/accounting', methods=['GET', 'POST'])
def accounting():
    lang = request.args.get('lang', 'en')
    conn = get_db_connection()
    if request.method == 'POST':
        journal = request.form.get('journal', '').strip()
        account_code = request.form.get('account_code', '').strip()
        account_name = request.form.get('account_name', '').strip()
        debit = float(request.form.get('debit', '0') or 0)
        credit = float(request.form.get('credit', '0') or 0)
        memo = request.form.get('memo', '').strip()
        if account_code and account_name:
            conn.execute(
                'INSERT INTO accounting_entries (journal, account_code, account_name, debit, credit, memo) VALUES (?, ?, ?, ?, ?, ?)',
                (journal, account_code, account_name, debit, credit, memo)
            )
            conn.execute(
                '''
                INSERT OR IGNORE INTO chart_of_accounts (account_code, account_name, account_type, normal_balance, description)
                VALUES (?, ?, ?, ?, ?)
                ''',
                (account_code, account_name, 'General', 'Debit' if debit > credit else 'Credit', memo)
            )
            conn.commit()
        conn.close()
        return redirect(url_for('accounting', lang=lang))
    rows = conn.execute('SELECT * FROM accounting_entries ORDER BY id DESC').fetchall()
    summary = conn.execute('SELECT SUM(debit) AS total_debit, SUM(credit) AS total_credit FROM accounting_entries').fetchone()
    accounts = conn.execute('SELECT * FROM chart_of_accounts ORDER BY account_code').fetchall()
    journal_rows = conn.execute('SELECT * FROM journal_entries ORDER BY id DESC LIMIT 10').fetchall()
    conn.close()
    return render_template('accounting.html', lang=lang, entries=rows, summary=summary, accounts=accounts, journals=journal_rows)


@app.route('/ledger', methods=['GET', 'POST'])
def ledger():
    lang = request.args.get('lang', 'en')
    conn = get_db_connection()
    if request.method == 'POST':
        entry_no = request.form.get('entry_no', '').strip()
        entry_date = request.form.get('entry_date', '')
        description = request.form.get('description', '').strip()
        account_code = request.form.get('account_code', '').strip()
        account_name = request.form.get('account_name', '').strip()
        debit = float(request.form.get('debit', '0') or 0)
        credit = float(request.form.get('credit', '0') or 0)
        memo = request.form.get('memo', '').strip()
        if entry_no and account_code and account_name:
            existing_entry = conn.execute('SELECT id FROM journal_entries WHERE entry_no = ?', (entry_no,)).fetchone()
            if existing_entry:
                entry_id = existing_entry['id']
            else:
                entry_date_value = entry_date or datetime.utcnow().strftime('%Y-%m-%d')
                conn.execute(
                    'INSERT INTO journal_entries (entry_no, entry_date, description, total_debit, total_credit, status) VALUES (?, ?, ?, ?, ?, ?)',
                    (entry_no, entry_date_value, description or 'General journal entry', debit, credit, 'Posted')
                )
                entry_id = conn.execute('SELECT last_insert_rowid() AS id').fetchone()['id']
            conn.execute(
                'INSERT INTO journal_entry_lines (entry_id, account_code, account_name, debit, credit, memo) VALUES (?, ?, ?, ?, ?, ?)',
                (entry_id, account_code, account_name, debit, credit, memo)
            )
            conn.execute(
                'UPDATE journal_entries SET total_debit = (SELECT COALESCE(SUM(debit), 0) FROM journal_entry_lines WHERE entry_id = ?), total_credit = (SELECT COALESCE(SUM(credit), 0) FROM journal_entry_lines WHERE entry_id = ?) WHERE id = ?',
                (entry_id, entry_id, entry_id)
            )
            conn.commit()
        conn.close()
        return redirect(url_for('ledger', lang=lang))
    account_rows = conn.execute('SELECT * FROM chart_of_accounts ORDER BY account_code').fetchall()
    entries = conn.execute('SELECT j.*, (SELECT COUNT(*) FROM journal_entry_lines WHERE entry_id = j.id) AS lines_count FROM journal_entries j ORDER BY j.id DESC').fetchall()
    conn.close()
    return render_template('ledger.html', lang=lang, accounts=account_rows, entries=entries)


@app.route('/trial-balance')
def trial_balance():
    lang = request.args.get('lang', 'en')
    conn = get_db_connection()
    rows = conn.execute(
        '''
        SELECT a.account_code, a.account_name, a.account_type, a.normal_balance,
               COALESCE(SUM(l.debit), 0) AS total_debit,
               COALESCE(SUM(l.credit), 0) AS total_credit,
               COALESCE(SUM(l.debit) - SUM(l.credit), 0) AS net_balance
        FROM chart_of_accounts a
        LEFT JOIN journal_entry_lines l ON l.account_code = a.account_code
        GROUP BY a.id, a.account_code, a.account_name, a.account_type, a.normal_balance
        ORDER BY a.account_code
        '''
    ).fetchall()
    conn.close()
    return render_template('trial_balance.html', lang=lang, rows=rows)


@app.route('/financial-statements')
def financial_statements():
    lang = request.args.get('lang', 'en')
    conn = get_db_connection()
    revenue = conn.execute(
        '''
        SELECT COALESCE(SUM(CASE WHEN a.account_type = 'Revenue' THEN COALESCE(l.credit, 0) - COALESCE(l.debit, 0) ELSE 0 END), 0) AS revenue_total,
               COALESCE(SUM(CASE WHEN a.account_type = 'Expense' THEN COALESCE(l.debit, 0) - COALESCE(l.credit, 0) ELSE 0 END), 0) AS expense_total
        FROM chart_of_accounts a
        LEFT JOIN journal_entry_lines l ON l.account_code = a.account_code
        '''
    ).fetchone()
    revenue_total = float(revenue['revenue_total'] or 0)
    expense_total = float(revenue['expense_total'] or 0)
    net_income = revenue_total - expense_total
    assets = conn.execute(
        '''
        SELECT a.account_name, a.account_code, COALESCE(SUM(l.debit) - SUM(l.credit), 0) AS balance
        FROM chart_of_accounts a
        LEFT JOIN journal_entry_lines l ON l.account_code = a.account_code
        WHERE a.account_type = 'Asset'
        GROUP BY a.id, a.account_name, a.account_code
        ORDER BY a.account_code
        '''
    ).fetchall()
    liabilities = conn.execute(
        '''
        SELECT a.account_name, a.account_code, COALESCE(SUM(l.credit) - SUM(l.debit), 0) AS balance
        FROM chart_of_accounts a
        LEFT JOIN journal_entry_lines l ON l.account_code = a.account_code
        WHERE a.account_type = 'Liability'
        GROUP BY a.id, a.account_name, a.account_code
        ORDER BY a.account_code
        '''
    ).fetchall()
    equity = conn.execute(
        '''
        SELECT a.account_name, a.account_code, COALESCE(SUM(l.credit) - SUM(l.debit), 0) AS balance
        FROM chart_of_accounts a
        LEFT JOIN journal_entry_lines l ON l.account_code = a.account_code
        WHERE a.account_type = 'Equity'
        GROUP BY a.id, a.account_name, a.account_code
        ORDER BY a.account_code
        '''
    ).fetchall()
    conn.close()
    return render_template(
        'financial_statements.html',
        lang=lang,
        revenue_total=revenue_total,
        expense_total=expense_total,
        net_income=net_income,
        assets=assets,
        liabilities=liabilities,
        equity=equity,
    )


@app.route('/customers', methods=['GET', 'POST'])
def customers_module():
    lang = request.args.get('lang', 'en')
    conn = get_db_connection()
    if request.method == 'POST':
        customer_name = request.form.get('customer_name', '').strip()
        company = request.form.get('company', '').strip()
        email = request.form.get('email', '').strip()
        phone = request.form.get('phone', '').strip()
        segment = request.form.get('segment', '').strip()
        status = request.form.get('status', 'Active')
        if customer_name:
            conn.execute(
                'INSERT INTO customers (customer_name, company, email, phone, segment, status, company_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                (customer_name, company, email, phone, segment, status, get_active_company_id())
            )
            conn.commit()
        conn.close()
        return redirect(url_for('customers_module', lang=lang))
    cid = get_active_company_id()
    rows = conn.execute('SELECT * FROM customers' + (' WHERE company_id = ?' if cid else '') + ' ORDER BY id DESC', (cid,) if cid else () ).fetchall()
    summary = conn.execute('SELECT COUNT(*) AS total_customers, SUM(CASE WHEN status = "Active" THEN 1 ELSE 0 END) AS active_customers FROM customers' + (' WHERE company_id = ?' if cid else ''), (cid,) if cid else () ).fetchone()
    conn.close()
    return render_template('customers.html', lang=lang, customers=rows, summary=summary)


@app.route('/suppliers', methods=['GET', 'POST'])
def suppliers_module():
    lang = request.args.get('lang', 'en')
    conn = get_db_connection()
    if request.method == 'POST':
        supplier_name = request.form.get('supplier_name', '').strip()
        contact_name = request.form.get('contact_name', '').strip()
        email = request.form.get('email', '').strip()
        phone = request.form.get('phone', '').strip()
        category = request.form.get('category', '').strip()
        status = request.form.get('status', 'Active')
        if supplier_name:
            conn.execute(
                'INSERT INTO suppliers (supplier_name, contact_name, email, phone, category, status, company_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                (supplier_name, contact_name, email, phone, category, status, get_active_company_id())
            )
            conn.commit()
        conn.close()
        return redirect(url_for('suppliers_module', lang=lang))
    cid = get_active_company_id()
    rows = conn.execute('SELECT * FROM suppliers' + (' WHERE company_id = ?' if cid else '') + ' ORDER BY id DESC', (cid,) if cid else () ).fetchall()
    summary = conn.execute('SELECT COUNT(*) AS total_suppliers, SUM(CASE WHEN status = "Active" THEN 1 ELSE 0 END) AS active_suppliers FROM suppliers' + (' WHERE company_id = ?' if cid else ''), (cid,) if cid else () ).fetchone()
    conn.close()
    return render_template('suppliers.html', lang=lang, suppliers=rows, summary=summary)


@app.route('/inventory', methods=['GET', 'POST'])
def inventory_module():
    lang = request.args.get('lang', 'en')
    conn = get_db_connection()
    if request.method == 'POST':
        item_name = request.form.get('item_name', '').strip()
        category = request.form.get('category', '').strip()
        sku = request.form.get('sku', '').strip()
        quantity = float(request.form.get('quantity', '0') or 0)
        unit_cost = float(request.form.get('unit_cost', '0') or 0)
        reorder_level = float(request.form.get('reorder_level', '0') or 0)
        warehouse = request.form.get('warehouse', '').strip()
        if item_name:
            conn.execute(
                'INSERT INTO inventory_items (item_name, category, sku, quantity, unit_cost, reorder_level, warehouse, company_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                (item_name, category, sku, quantity, unit_cost, reorder_level, warehouse, get_active_company_id())
            )
            conn.commit()
        conn.close()
        return redirect(url_for('inventory_module', lang=lang))
    rows = conn.execute('SELECT * FROM inventory_items ORDER BY id DESC').fetchall()
    summary = conn.execute('SELECT COUNT(*) AS total_items, SUM(quantity) AS total_quantity, ROUND(SUM(quantity * unit_cost), 2) AS inventory_value FROM inventory_items').fetchone()
    conn.close()
    return render_template('inventory.html', lang=lang, items=rows, summary=summary)


@app.route('/purchases', methods=['GET', 'POST'])
def purchases_module():
    lang = request.args.get('lang', 'en')
    conn = get_db_connection()
    if request.method == 'POST':
        order_no = request.form.get('order_no', '').strip()
        supplier_name = request.form.get('supplier_name', '').strip()
        item_name = request.form.get('item_name', '').strip()
        quantity = float(request.form.get('quantity', '0') or 0)
        unit_cost = float(request.form.get('unit_cost', '0') or 0)
        total = float(request.form.get('total', '0') or 0)
        status = request.form.get('status', 'Pending')
        if order_no and supplier_name:
            conn.execute(
                'INSERT INTO purchase_orders (order_no, supplier_name, item_name, quantity, unit_cost, total, status, company_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                (order_no, supplier_name, item_name, quantity, unit_cost, total, status, get_active_company_id())
            )
            conn.commit()
        conn.close()
        return redirect(url_for('purchases_module', lang=lang))
    rows = conn.execute('SELECT * FROM purchase_orders ORDER BY id DESC').fetchall()
    summary = conn.execute('SELECT COUNT(*) AS total_orders, SUM(total) AS total_value, SUM(CASE WHEN status = "Approved" THEN total ELSE 0 END) AS approved_value FROM purchase_orders').fetchone()
    conn.close()
    return render_template('purchases.html', lang=lang, purchases=rows, summary=summary)


@app.route('/reports/export.csv')
def export_reports_csv():
    conn = get_db_connection()
    rows = conn.execute('SELECT employee_code, employee_name, period, net FROM payroll_runs UNION ALL SELECT "", "", "", 0 WHERE 1=0').fetchall()
    # Use a simple combined CSV export from payroll and finance for a quick operational report
    csv_lines = ['employee_code,employee_name,period,net,category,description,amount']
    payroll_rows = conn.execute('SELECT employee_code, employee_name, period, net FROM payroll_runs ORDER BY id DESC').fetchall()
    finance_rows = conn.execute('SELECT category, description, amount FROM finance_transactions ORDER BY id DESC').fetchall()
    for p in payroll_rows:
        csv_lines.append(f'{p["employee_code"]},{p["employee_name"]},{p["period"]},{p["net"]},, ,')
    for f in finance_rows:
        csv_lines.append(f',,,,{f["category"]},{f["description"]},{f["amount"]}')
    conn.close()
    csv_data = '\n'.join(csv_lines)
    return csv_data, 200, {'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename=erp_report.csv'}


@app.route('/import')
def import_data():
    lang = request.args.get('lang', 'en')
    if not EXCEL_FILE.exists():
        return 'Excel file not found: ' + str(EXCEL_FILE), 400
    cmd = ['python', 'import_excel.py', '--file', str(EXCEL_FILE), '--lang', lang]
    code, out = run_script(cmd)
    return render_template('result.html', title='Import Excel', output=out, lang=lang)


@app.route('/upload', methods=['GET','POST'])
def upload():
    lang = request.args.get('lang', 'en')
    i18n.set_language(lang)
    if request.method == 'POST':
        if 'file' not in request.files:
            return render_template('result.html', title='Upload', output='No file part', lang=lang)
        f = request.files['file']
        if f.filename == '':
            return render_template('result.html', title='Upload', output='No selected file', lang=lang)
        dest = PROJECT_ROOT / f.filename
        f.save(str(dest))
        return render_template('result.html', title='Upload', output=f'Saved to {dest}', lang=lang)
    return render_template('upload.html', lang=lang)


@app.route('/test_db')
def test_db():
    lang = request.args.get('lang', 'en')
    i18n.set_language(lang)
    try:
        conn = sqlite3.connect(DB_PATH)
        r = conn.execute('SELECT 1').fetchone()
        conn.close()
        return render_template('result.html', title='DB Test', output='Connection OK: ' + str(r), lang=lang)
    except Exception as e:
        return render_template('result.html', title='DB Test', output='Connection failed: ' + str(e), lang=lang)


@app.route('/run_all')
def run_all():
    lang = request.args.get('lang', 'en')
    cmd = ['python', 'run_all.py', '--file', str(EXCEL_FILE), '--year', '2026', '--month', '8', '--lang', lang]
    code, out = run_script(cmd)
    return render_template('result.html', title='Run All', output=out, lang=lang)


@app.route('/generate_payslips')
def gen_payslips():
    lang = request.args.get('lang', 'en')
    year = request.args.get('year', '2026')
    month = request.args.get('month', '8')
    cmd = ['python', 'generate_payslips.py', '--year', year, '--month', month, '--lang', lang]
    code, out = run_script(cmd)
    return render_template('result.html', title='Generate Payslips', output=out, lang=lang)


@app.route('/init_leaves')
def init_leaves():
    lang = request.args.get('lang', 'en')
    year = request.args.get('year', '2026')
    cmd = ['python', 'leave_manager.py', '--init', '--year', year, '--lang', lang]
    code, out = run_script(cmd)
    return render_template('result.html', title='Init Leaves', output=out, lang=lang)


@app.route('/archive')
def archive():
    lang = request.args.get('lang', 'en')
    year = request.args.get('year', '2026')
    month = request.args.get('month', '8')
    cmd = ['python', 'archive_month.py', '--year', year, '--month', month, '--lang', lang]
    code, out = run_script(cmd)
    return render_template('result.html', title='Archive Month', output=out, lang=lang)


@app.route('/exports')
def exports():
    lang = request.args.get('lang', 'en')
    tables = request.args.get('tables', 'employees,payroll,loans')
    cmd = ['python', 'export_tables.py', '--tables', tables, '--lang', lang]
    code, out = run_script(cmd)
    return render_template('result.html', title='Export Tables', output=out, lang=lang)


@app.route('/payslips')
def list_payslips():
    lang = request.args.get('lang', 'en')
    folder = PAYS_DIR
    files = []
    if folder.exists():
        for f in sorted(folder.glob('**/*.pdf')):
            files.append(str(f.relative_to(PROJECT_ROOT)))
    return render_template('payslips.html', files=files, lang=lang)


@app.route('/download/<path:filename>')
def download_file(filename):
    path = PROJECT_ROOT / filename
    if not path.exists():
        return 'File not found', 404
    return send_from_directory(directory=str(path.parent), path=path.name, as_attachment=True)


@app.route('/settings', methods=['GET', 'POST'])
def settings():
    lang = request.args.get('lang', 'en')
    i18n.set_language(lang)
    if request.method == 'POST':
        vals = {
            'DB_HOST': request.form.get('db_host', 'localhost'),
            'DB_PORT': request.form.get('db_port', '5432'),
            'DB_NAME': request.form.get('db_name', 'hr_system'),
            'DB_USER': request.form.get('db_user', 'hradmin'),
            'DB_PASS': request.form.get('db_pass', ''),
            'LANG': request.form.get('lang', 'en'),
            'APP_THEME_PRIMARY': request.form.get('theme_primary', '#0b57d0'),
            'APP_THEME_SECONDARY': request.form.get('theme_secondary', '#0f172a'),
            'APP_THEME_ACCENT': request.form.get('theme_accent', '#22c55e'),
            'APP_THEME_SIDEBAR': request.form.get('theme_sidebar', 'linear-gradient(180deg, #0b1732 0%, #12254a 100%)')
        }
        write_env(vals)
        db_conn = get_db_connection()
        existing = db_conn.execute('SELECT id FROM company_settings ORDER BY id DESC LIMIT 1').fetchone()
        payload = (
            request.form.get('company_name', 'Al Obaidi ERP'),
            request.form.get('company_email', 'admin@company.com'),
            request.form.get('company_phone', '+964 770 000 0000'),
            request.form.get('currency', 'USD'),
            float(request.form.get('tax_rate', '15') or 15),
            request.form.get('address', 'Baghdad, Iraq'),
            request.form.get('timezone', 'UTC+3')
        )
        if existing:
            db_conn.execute(
                '''
                UPDATE company_settings
                SET company_name = ?, company_email = ?, company_phone = ?, currency = ?, tax_rate = ?, address = ?, timezone = ?
                WHERE id = ?
                ''',
                (*payload, existing['id'])
            )
        else:
            db_conn.execute(
                '''
                INSERT INTO company_settings (company_name, company_email, company_phone, currency, tax_rate, address, timezone)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ''',
                payload
            )
        db_conn.commit()
        db_conn.close()
        i18n.set_language(vals.get('LANG', 'en'))
        return render_template('result.html', title=i18n.t('settings_title'), output=i18n.t('settings_saved'), lang=vals.get('LANG', 'en'))
    vals = read_env()
    company_settings = get_company_settings()
    i18n.set_language(lang)
    return render_template('settings.html', vals=vals, company_settings=company_settings, lang=lang)


if __name__ == '__main__':
    init_db()
    port = int(os.getenv('PORT', '8000'))
    app.run(host='0.0.0.0', port=port)
