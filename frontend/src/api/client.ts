import type { Assignee, MilestoneSummary, Project, ProjectDetail, ProjectListItem, ProjectMember, Task, TaskWithAssignees, User } from '../types';

// ── Base fetch ────────────────────────────────────────────────────────────────

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    credentials: 'include',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  // 204 No Content
  if (res.status === 204) return undefined as T;
  return res.json();
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export const auth = {
  me: () =>
    request<User>('/api/auth/me'),

  login: (username: string, password: string) =>
    request<{ user: User }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  logout: () =>
    request<void>('/api/auth/logout', { method: 'POST' }),
};

// ── Projects ──────────────────────────────────────────────────────────────────

export type CreateProjectInput = { name: string; description?: string; target_date?: string };
export type UpdateProjectInput = {
  name?: string;
  description?: string | null;
  target_date?: string | null;
  status?: 'active' | 'archived';
};

export const projects = {
  list: () =>
    request<ProjectListItem[]>('/api/projects'),

  get: (id: number) =>
    request<ProjectDetail>(`/api/projects/${id}`),

  create: (input: CreateProjectInput) =>
    request<Project>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  update: (id: number, input: UpdateProjectInput) =>
    request<Project>(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  archive: (id: number) =>
    request<void>(`/api/projects/${id}`, { method: 'DELETE' }),

  listMembers: (id: number) =>
    request<ProjectMember[]>(`/api/projects/${id}/members`),

  addMember: (id: number, userId: number, role?: string) =>
    request<void>(`/api/projects/${id}/members`, {
      method: 'POST',
      body: JSON.stringify({ user_id: userId, role }),
    }),

  removeMember: (id: number, userId: number) =>
    request<void>(`/api/projects/${id}/members/${userId}`, { method: 'DELETE' }),
};

// ── Milestones ────────────────────────────────────────────────────────────────

export type CreateMilestoneInput = {
  name: string;
  description?: string;
  target_date?: string;
  due_date?: string;
};
export type UpdateMilestoneInput = {
  name?: string;
  description?: string | null;
  status?: 'open' | 'in_progress' | 'done' | 'cancelled';
  target_date?: string | null;
  due_date?: string | null;
};

export const milestones = {
  list: (projectId: number) =>
    request<MilestoneSummary[]>(`/api/projects/${projectId}/milestones`),

  create: (projectId: number, input: CreateMilestoneInput) =>
    request<MilestoneSummary>(`/api/projects/${projectId}/milestones`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  update: (id: number, input: UpdateMilestoneInput) =>
    request<MilestoneSummary>(`/api/milestones/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  delete: (id: number) =>
    request<void>(`/api/milestones/${id}`, { method: 'DELETE' }),

  reorder: (id: number, sortOrder: number) =>
    request<MilestoneSummary[]>(`/api/milestones/${id}/reorder`, {
      method: 'PATCH',
      body: JSON.stringify({ sort_order: sortOrder }),
    }),
};

// ── Tasks ─────────────────────────────────────────────────────────────────────

export type CreateTaskInput = {
  title: string;
  description?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  due_date?: string;
};
export type UpdateTaskInput = {
  title?: string;
  description?: string | null;
  status?: 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  due_date?: string | null;
};

export const tasks = {
  list: (milestoneId: number) =>
    request<TaskWithAssignees[]>(`/api/milestones/${milestoneId}/tasks`),

  create: (milestoneId: number, input: CreateTaskInput) =>
    request<TaskWithAssignees>(`/api/milestones/${milestoneId}/tasks`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  update: (id: number, input: UpdateTaskInput) =>
    request<TaskWithAssignees>(`/api/tasks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  delete: (id: number) =>
    request<void>(`/api/tasks/${id}`, { method: 'DELETE' }),

  assign: (id: number, userId: number) =>
    request<TaskWithAssignees>(`/api/tasks/${id}/assign`, {
      method: 'POST',
      body: JSON.stringify({ user_id: userId }),
    }),

  unassign: (id: number, userId: number) =>
    request<void>(`/api/tasks/${id}/assign/${userId}`, { method: 'DELETE' }),

  reorder: (id: number, milestoneId: number, sortOrder: number) =>
    request<TaskWithAssignees>(`/api/tasks/${id}/reorder`, {
      method: 'PATCH',
      body: JSON.stringify({ milestone_id: milestoneId, sort_order: sortOrder }),
    }),
};

export { ApiError };
export type { Project, ProjectListItem, ProjectDetail, ProjectMember, MilestoneSummary, Task, TaskWithAssignees, Assignee, User };
