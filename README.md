# نظام ERP متكامل
## Integrated ERP System

نظام إدارة موارد المؤسسات (ERP) شامل يركز على إدارة الموارد البشرية مع ربطها بأنظمة الحسابات والتدقيق لتسهيل إدارة العمليات اليومية.

### المرحلة الأولى: نظام الموارد البشرية 🎯
- إدارة الموظفين والبيانات الشخصية
- إدارة الحضور والغياب
- إدارة الإجازات والعطل
- إدارة الرواتب والمكافآت
- تقارير الأداء والتقييمات
- **ربط كامل مع نظام المحاسبة**

### المراحل اللاحقة:
- نظام المحاسبة والفواتير
- إدارة المبيعات
- إدارة المستودعات والمخزون
- التدقيق والمراجعة

---

## التقنيات المستخدمة

### Stack:
- **Frontend:** React 18 + TypeScript + Tailwind CSS
- **Backend:** Node.js + Express + TypeScript
- **Database:** PostgreSQL + Sequelize ORM
- **Authentication:** JWT + Role-based Access Control (RBAC)
- **Deployment:** AWS (EC2, RDS, S3)
- **API Documentation:** Swagger/OpenAPI

---

## البنية الأساسية

```
Aws-Firas---laith-Al-Obaidi-ERP/
├── backend/                    # Node.js + Express
│   ├── src/
│   │   ├── config/            # إعدادات قاعدة البيانات والبيئة
│   │   ├── controllers/        # معالجات الطلبات
│   │   ├── models/            # نماذج قاعدة البيانات
│   │   ├── routes/            # مسارات API
│   │   ├── middleware/        # Middleware للمصادقة والتحقق
│   │   ├── services/          # منطق العمل
│   │   ├── utils/             # دوال مساعدة
│   │   └── index.ts           # نقطة الدخول
│   ├── migrations/            # ترحيلات قاعدة البيانات
│   ├── seeders/              # بيانات اختبارية
│   ├── package.json
│   ├── tsconfig.json
│   └── .env.example
│
├── frontend/                   # React
│   ├── public/
│   ├── src/
│   │   ├── components/        # مكونات React
│   │   ├── pages/            # الصفحات
│   │   ├── services/         # خدمات API
│   │   ├── hooks/            # React hooks
│   │   ├── utils/            # دوال مساعدة
│   │   ├── types/            # TypeScript types
│   │   ├── styles/           # ملفات CSS
│   │   └── App.tsx
│   ├── package.json
│   ├── tsconfig.json
│   └── .env.example
│
├── database/                   # ملفات قاعدة البيانات
│   ├── schema.sql            # مخطط قاعدة البيانات
│   └── migrations/           # ترحيلات Sequelize
│
├── docs/                       # التوثيق
│   ├── API.md               # توثيق API
│   ├── DATABASE.md          # توثيق قاعدة البيانات
│   ├── DEPLOYMENT.md        # توثيق النشر
│   └── ARCHITECTURE.md      # المعمارية
│
├── docker-compose.yml         # Docker Compose للتطوير
├── .github/
│   └── workflows/            # CI/CD pipelines
│
└── .gitignore
```

---

## البدء السريع

### المتطلبات:
- Node.js v18+
- PostgreSQL 14+
- npm أو yarn

### التثبيت:

```bash
# استنساخ المشروع
git clone https://github.com/hrharlow88-dotcom/Aws-Firas---laith-Al-Obaidi-ERP.git
cd Aws-Firas---laith-Al-Obaidi-ERP

# Backend setup
cd backend
npm install
cp .env.example .env
npm run db:migrate
npm run dev

# في نافذة أخرى - Frontend setup
cd frontend
npm install
cp .env.example .env
npm start
```

---

## ملفات المشروع

- الـ Backend يعمل على: `http://localhost:5000`
- الـ Frontend يعمل على: `http://localhost:3000`
- API Documentation: `http://localhost:5000/api-docs`

---

## الخطوات التالية

1. [ ] إعداد بنية قاعدة البيانات
2. [ ] إنشاء نماذج الموظفين والحسابات
3. [ ] بناء APIs للموارد البشرية
4. [ ] بناء واجهة المستخدم الأساسية
5. [ ] دمج نظام المحاسبة
6. [ ] إعداد المصادقة والتفويض

---

## المساهمة

يرجى الالتزام بـ commit messages واضحة وفتح PRs للتطوير.

---

## الترخيص

MIT License
