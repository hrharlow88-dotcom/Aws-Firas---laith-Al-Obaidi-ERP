دليل سريع لتشغيل PostgreSQL في حاوية على جهازك واستيراد ملف الإكسل المرفق

الهدف: جعل الحاسوب المحمول لديك هو "المضيف" الذي يشغّل الحاوية (container) لقاعدة البيانات ثم استيراد ملف Excel إلى DB.

الخطوات التفصيلية:

1) تثبيت متطلبات أساسية على الجهاز (مرة واحدة):
   - ثبت Docker Desktop من: https://www.docker.com/get-started
   - ثبت Python 3.8+ إن لم يكن مثبتًا

2) تشغيل قاعدة البيانات بالحاوية:
   - افتح موجه الأوامر في مجلد المشروع (المجلد الذي يحوي docker-compose.yml)
   - شغّل الأمر:
       docker-compose up -d
   - هذا ينشئ خدمة Postgres باسم "db" مع اسم مستخدم افتراضي hradmin وكلمة المرور "change_me_now" وقاعدة بيانات "hr_system".
   - ملاحظة: غير كلمة المرور في docker-compose.yml قبل التشغيل لإنتاجية أكبر.

3) تثبيت تبعيات Python (داخل بيئة افتراضية موصى بها):
   - python -m venv .venv
   - .venv\Scripts\activate
   - pip install -r requirements.txt

4) استيراد ملف الإكسل إلى قاعدة البيانات:
   - ملف الإكسل تم نسخه إلى مجلد العمل باسم: Laith_Al-Obaidi_HR_System_2026.xlsx
   - شغّل:
       python import_excel.py --file "Laith_Al-Obaidi_HR_System_2026.xlsx" \
         --dbuser hradmin --dbpass change_me_now --dbname hr_system --host localhost --port 5432

   - يمكن تعديل المعلمات (--dbpass، --dbuser، ...) لتطابق ما في docker-compose.yml.

5) التحقق:
   - استخدم أي عميل PostgreSQL (pgAdmin، DBeaver، psql) للاتصال إلى localhost:5432 ومراجعة الجداول: employees, payroll, loans, leaves, payslips

6) خطوات قادمة مذكورة (ملاحظة عمل):
   - توليد Payslips PDF: هناك مكتبة reportlab مضمنة كخيار في requirements.txt — يمكن تنفيذ قالب Jinja2 ثم توليد PDF لكل موظف
   - نظام الإجازات: بعد الاستيراد، تحتاج دالة تُحسب الأرصدة الافتتاحية لكل سنة، وتحسَب النقاط عند استخدام الإجازة وتسجل التسجيلات في جدول leaves
   - أرشفة شهرية: عند اكتمال شهر، انسخ السجلات إلى monthly_archives أو أنشئ جدول أرشفة مرتبطة بالسنة/الشهر

7) إن Docker غير متاح/لا ترغب بتشغيل الحاوية:
   - بديل سريع: استخدم SQLite محليًا. أزودك بسكريبت تحويل سريع إذا رغبت.

ملاحظات أمنية:
 - لا تستخدم كلمات مرور افتراضية في بيئة إنتاج. غيّر POSTGRES_PASSWORD في docker-compose.yml.
 - تأكد من أن المنفذ 5432 غير مكشوف للإنترنت عند العمل على شبكة عامة.

تمت إضافة سكريبتات احترافية للتشغيل بعد الاستيراد:
 - generate_payslips.py  -> توليد PDF قسائم راتب لكل موظف عن شهر وسنة محددين (يستخدم reportlab)
 - leave_manager.py     -> أدوات لإدارة الإجازات: تهيئة أرصدة افتتاحية، خصم أيام، وحساب الرصيد المتبقي
 - validate_data.py     -> فحص تناسق جداول الرواتب (فارق صافي/الإجمالي/الخصومات)
 - export_tables.py     -> تصدير جداول محددة إلى CSV وJSON
 - archive_month.py     -> أرشفة شهرية: تفريغ جداول CSV وتسجيل مدخل بالأرشيف
 - run_all.py           -> سكريبت تنفيذي يلزّم تشغيل كامل: استيراد -> تدقيق -> تصدير -> توليد Payslips -> تهيئة إجازات -> أرشفة

أمثلة سريعة بعد تشغيل الحاوية وتثبيت المتطلبات (يدعم اختيار اللغة --lang en أو --lang ar):
  python run_all.py --file Laith_Al-Obaidi_HR_System_2026.xlsx --year 2026 --month 8 --lang ar
  python generate_payslips.py --year 2026 --month 8 --lang ar
  python leave_manager.py --init --year 2026 --lang ar

توجيه: قبل التشغيل غيّر كلمة المرور الافتراضية في docker-compose.yml ونسّخ .env.example إلى .env إذا رغبت بتجاوز المتغيرات عبر بيئة التشغيل.
