import { Request, Response } from 'express';
import { Branch, Employee } from '../models';
import { audited } from '../utils/audit';

export class BranchController {
  static async list(req: Request, res: Response): Promise<void> {
    if (req.user?.role === 'branch_manager' && !req.user.branchId) {
      res.json({ data: [] });
      return;
    }
    const branchFilter = req.user?.role === 'branch_manager' ? req.user.branchId : undefined;
    const branches = await Branch.findAll({
      where: branchFilter ? { id: branchFilter } : undefined,
      order: [['name', 'ASC']],
    });
    const counts = await Promise.all(
      branches.map((branch) => Employee.count({ where: { branchId: branch.id } })),
    );
    res.json({
      data: branches.map((branch, index) => ({ ...branch.toJSON(), employeeCount: counts[index] })),
    });
  }

  static async create(req: Request, res: Response): Promise<void> {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const { code, name, city, address, phone } = body;
    if (![code, name, city].every((value) => typeof value === 'string' && value.trim())) {
      res.status(400).json({ message: 'رمز الفرع والاسم والمدينة حقول مطلوبة.' });
      return;
    }
    const branch = await audited(req.user!.id, 'branch.created', 'branch', (transaction) => Branch.create({
      code: code.trim().toUpperCase(),
      name: name.trim(),
      city: city.trim(),
      address: typeof address === 'string' ? address.trim() || null : null,
      phone: typeof phone === 'string' ? phone.trim() || null : null,
    }, { transaction }));
    res.status(201).json({ data: branch });
  }

  static async update(req: Request, res: Response): Promise<void> {
    const branch = await Branch.findByPk(req.params.id);
    if (!branch) {
      res.status(404).json({ message: 'الفرع غير موجود.' });
      return;
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const { code, name, city, address, phone, isActive } = body;
    if (Object.keys(body).some((field) => !['code', 'name', 'city', 'address', 'phone', 'isActive'].includes(field))) {
      res.status(400).json({ message: 'يتضمن الطلب حقلاً غير قابل للتعديل.' });
      return;
    }
    if (
      ['code', 'name', 'city'].some((field) => field in body && (typeof body[field] !== 'string' || !body[field].trim())) ||
      (isActive !== undefined && typeof isActive !== 'boolean')
    ) {
      res.status(400).json({ message: 'تحقق من رمز الفرع والاسم والمدينة والحالة.' });
      return;
    }
    if (!['code', 'name', 'city', 'address', 'phone', 'isActive'].some((field) => field in body)) {
      res.status(400).json({ message: 'أرسل حقلاً واحداً على الأقل لتحديثه.' });
      return;
    }
    const updatedBranch = await audited(req.user!.id, 'branch.updated', 'branch', (transaction) => branch.update({
      ...(typeof code === 'string' ? { code: code.trim().toUpperCase() } : {}),
      ...(typeof name === 'string' ? { name: name.trim() } : {}),
      ...(typeof city === 'string' ? { city: city.trim() } : {}),
      ...(typeof address === 'string' ? { address: address.trim() || null } : {}),
      ...(typeof phone === 'string' ? { phone: phone.trim() || null } : {}),
      ...(typeof isActive === 'boolean' ? { isActive } : {}),
    }, { transaction }));
    res.json({ data: updatedBranch });
  }
}

export default BranchController;
