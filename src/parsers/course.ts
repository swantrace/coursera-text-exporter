import { AppError } from '../shared/errors';
import type { Course, Item } from '../shared/types';
export type Obj = Record<string, any>;
export function object(value: unknown): Obj { return value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {}; }
export function rows(value: unknown): Obj[] { return Array.isArray(value) ? value.map(object) : []; }
export function collection(raw: Obj, name: string): Obj[] { return rows(object(raw.linked)[name]); }
function id(value: unknown): string { return typeof value === 'string' || typeof value === 'number' ? String(value) : String(object(value).id ?? ''); }
function ids(value: unknown): string[] { return Array.isArray(value) ? value.map(id) : []; }
export function parseCourse(input: unknown, slug: string): Course {
  const raw = object(input), root = rows(raw.elements)[0];
  if (!root) throw new AppError('SCHEMA_MISMATCH', '课程大纲没有 elements；请检查课程链接、登录状态或 API 响应。');
  if (object(raw.paging).next) throw new AppError('PAGINATION_REQUIRED', '大纲响应仍有下一页，当前适配器拒绝将截断数据视为完整课程。');
  const modules = collection(raw, 'onDemandCourseMaterialModules.v1');
  const lessons = collection(raw, 'onDemandCourseMaterialLessons.v1');
  const items = collection(raw, 'onDemandCourseMaterialItems.v2');
  const courseId = id(root.courseId ?? root.id);
  if (!courseId || !modules.length) throw new AppError('SCHEMA_MISMATCH', '无法定位 courseId 或 modules，需要校验课程大纲字段。');
  const warnings: string[] = [];
  function ordered(values: Obj[], references: unknown, label: string): Obj[] {
    if (!Array.isArray(references)) { warnings.push(`${label} 未提供排序引用，使用 API 集合顺序。`); return values; }
    const map = new Map(values.map(v => [id(v.id), v]));
    return ids(references).map(key => {
      const value = map.get(key);
      if (!value) throw new AppError('MISSING_REFERENCE', `${label} 缺少课时关联 ${key}，API 可能只返回了预览内容。请在同一 Chrome 中登录并确认课程访问权限，再点击重试失败。`);
      return value;
    });
  }
  function item(row: Obj): Item {
    const summary = object(row.contentSummary);
    const type = String(summary.typeName ?? row.typeName ?? row.type ?? 'unsupported');
    return { id: id(row.id), title: String(row.name ?? row.title ?? row.id), type,
      locked: row.isLocked === true || row.locked === true || object(row.access).isLocked === true };
  }
  return { id: courseId, slug, title: String(root.name ?? root.title ?? slug), warnings,
    modules: ordered(modules, root.moduleIds, '课程').map(m => ({
      id: id(m.id), title: String(m.name ?? m.title ?? m.id),
      lessons: ordered(Array.isArray(m.lessonIds) ? lessons : lessons.filter(l => id(l.moduleId) === id(m.id)), m.lessonIds, `模块 ${id(m.id)}`).map(l => ({
        id: id(l.id), title: String(l.name ?? l.title ?? l.id),
        items: ordered(Array.isArray(l.itemIds) ? items : items.filter(i => id(i.lessonId) === id(l.id)), l.itemIds, `课节 ${id(l.id)}`).map(item)
      }))
    }))
  };
}
