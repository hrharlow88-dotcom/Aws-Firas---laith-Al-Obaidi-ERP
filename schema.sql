-- Basic schema for HR/payroll system. Adjust types/columns to match Excel before using in production.

CREATE TABLE IF NOT EXISTS employees (
  id SERIAL PRIMARY KEY,
  employee_code TEXT,
  first_name TEXT,
  last_name TEXT,
  national_id TEXT,
  hire_date DATE,
  job_title TEXT,
  department TEXT,
  grade TEXT,
  salary_currency TEXT,
  base_salary NUMERIC(15,2),
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payroll (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  year INT,
  month INT,
  gross NUMERIC(15,2),
  net NUMERIC(15,2),
  tax NUMERIC(15,2),
  deductions NUMERIC(15,2),
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS loans (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
  amount NUMERIC(15,2),
  outstanding NUMERIC(15,2),
  start_date DATE,
  end_date DATE,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS leaves (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
  leave_type TEXT,
  opening_balance NUMERIC(10,2) DEFAULT 0,
  used NUMERIC(10,2) DEFAULT 0,
  year INT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payslips (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
  payroll_id INTEGER REFERENCES payroll(id) ON DELETE CASCADE,
  pdf_path TEXT,
  generated_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS monthly_archives (
  id SERIAL PRIMARY KEY,
  archive_month INT,
  archive_year INT,
  created_at TIMESTAMP DEFAULT now(),
  note TEXT
);
