import { AppError } from '../shared/errors';
import type { Course, Item } from '../shared/types';
export type Obj = Record<string, unknown>;
export function object(value: unknown): Obj {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Obj)
    : {};
}
export function rows(value: unknown): Obj[] {
  return Array.isArray(value) ? value.map(object) : [];
}
export function collection(raw: Obj, name: string): Obj[] {
  return rows(object(raw.linked)[name]);
}
function id(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : String(object(value).id ?? '');
}
function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.map(id) : [];
}
export function parseCourse(input: unknown, slug: string): Course {
  const raw = object(input),
    root = rows(raw.elements)[0];
  if (!root)
    throw new AppError(
      'SCHEMA_MISMATCH',
      'The course outline has no elements. Check the URL, login status, or API response.',
    );
  if (object(raw.paging).next)
    throw new AppError(
      'PAGINATION_REQUIRED',
      'The outline has another page. The adapter refuses to treat truncated data as a complete course.',
    );
  const modules = collection(raw, 'onDemandCourseMaterialModules.v1');
  const lessons = collection(raw, 'onDemandCourseMaterialLessons.v1');
  const items = collection(raw, 'onDemandCourseMaterialItems.v2');
  const courseId = id(root.courseId ?? root.id);
  if (!courseId || !modules.length)
    throw new AppError(
      'SCHEMA_MISMATCH',
      'Could not locate courseId or modules. Validate the outline fields.',
    );
  const warnings: string[] = [];
  function ordered(values: Obj[], references: unknown, label: string): Obj[] {
    if (!Array.isArray(references)) {
      warnings.push(
        `${label} has no ordering references; using API collection order.`,
      );
      return values;
    }
    const map = new Map(values.map((v) => [id(v.id), v]));
    return ids(references).map((key) => {
      const value = map.get(key);
      if (!value)
        throw new AppError(
          'MISSING_REFERENCE',
          `${label} is missing item reference ${key}. The API may have returned preview content only. Sign in using the same Chrome profile, confirm course access, and retry failed items.`,
        );
      return value;
    });
  }
  function item(row: Obj): Item {
    const summary = object(row.contentSummary);
    const type = String(
      summary.typeName ?? row.typeName ?? row.type ?? 'unsupported',
    );
    return {
      id: id(row.id),
      title: String(row.name ?? row.title ?? row.id),
      type,
      locked:
        row.isLocked === true ||
        row.locked === true ||
        object(row.access).isLocked === true,
    };
  }
  return {
    id: courseId,
    slug,
    title: String(root.name ?? root.title ?? slug),
    warnings,
    modules: ordered(modules, root.moduleIds, 'Course').map((m) => ({
      id: id(m.id),
      title: String(m.name ?? m.title ?? m.id),
      lessons: ordered(
        Array.isArray(m.lessonIds)
          ? lessons
          : lessons.filter((l) => id(l.moduleId) === id(m.id)),
        m.lessonIds,
        `Module ${id(m.id)}`,
      ).map((l) => ({
        id: id(l.id),
        title: String(l.name ?? l.title ?? l.id),
        items: ordered(
          Array.isArray(l.itemIds)
            ? items
            : items.filter((i) => id(i.lessonId) === id(l.id)),
          l.itemIds,
          `Lesson ${id(l.id)}`,
        ).map(item),
      })),
    })),
  };
}
