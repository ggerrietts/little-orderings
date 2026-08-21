import { createContext, useContext, useEffect, useState } from 'react'
import { projects as projectsApi, milestones as milestonesApi, tasks as tasksApi } from '../api/client'
import type { CreateMilestoneInput, UpdateMilestoneInput, CreateTaskInput, UpdateTaskInput, UpdateProjectInput } from '../api/client'
import type { ProjectDetail, MilestoneSummary, TaskWithAssignees, ProjectMember } from '../types'

interface ProjectContextType {
  project: ProjectDetail | null
  projectId: number
  milestones: MilestoneSummary[]
  tasks: TaskWithAssignees[]
  members: ProjectMember[]
  loading: boolean
  selectedTaskId: number | null
  setSelectedTaskId: (id: number | null) => void
  updateProject: (input: UpdateProjectInput) => Promise<void>
  addMilestone: (input: CreateMilestoneInput) => Promise<void>
  updateMilestone: (id: number, input: UpdateMilestoneInput) => Promise<void>
  deleteMilestone: (id: number) => Promise<void>
  reorderMilestone: (id: number, sortOrder: number) => Promise<void>
  addTask: (input: CreateTaskInput) => Promise<void>
  updateTask: (id: number, input: UpdateTaskInput) => Promise<void>
  deleteTask: (id: number) => Promise<void>
  reorderTask: (id: number, sortOrder: number, scoped: boolean) => Promise<void>
  assignUser: (taskId: number, userId: number) => Promise<void>
  unassignUser: (taskId: number, userId: number) => Promise<void>
  addMember: (member: ProjectMember) => Promise<void>
  removeMember: (userId: number) => Promise<void>
  updateMemberRole: (userId: number, role: string) => Promise<void>
}

export const ProjectContext = createContext<ProjectContextType | null>(null)

export function ProjectProvider({
  projectId,
  children,
}: {
  projectId: number
  children: React.ReactNode
}) {
  const [project, setProject] = useState<ProjectDetail | null>(null)
  const [milestones, setMilestones] = useState<MilestoneSummary[]>([])
  const [tasks, setTasks] = useState<TaskWithAssignees[]>([])
  const [members, setMembers] = useState<ProjectMember[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null)

  useEffect(() => {
    Promise.all([
      projectsApi.get(projectId),
      projectsApi.listMembers(projectId),
      tasksApi.list(projectId),
    ]).then(([proj, mems, taskList]) => {
      setProject(proj)
      setMembers(mems)
      setMilestones(proj.milestones)
      setTasks(taskList)
    }).finally(() => setLoading(false))
  }, [projectId])

  async function updateProject(input: UpdateProjectInput) {
    const updated = await projectsApi.update(projectId, input)
    setProject(prev => (prev ? { ...prev, ...updated } : prev))
  }

  async function addMilestone(input: CreateMilestoneInput) {
    const m = await milestonesApi.create(projectId, input)
    setMilestones(prev => [...prev, m])
  }

  async function updateMilestone(id: number, input: UpdateMilestoneInput) {
    const updated = await milestonesApi.update(id, input)
    setMilestones(prev => prev.map(m => m.id === id ? updated : m))
  }

  async function deleteMilestone(id: number) {
    await milestonesApi.delete(id)
    setMilestones(prev => prev.filter(m => m.id !== id))
    // The backend untags rather than deletes this milestone's tasks
    // (ON DELETE SET NULL) — mirror that locally instead of removing them.
    setTasks(prev => prev.map(t => t.milestone_id === id ? { ...t, milestone_id: null } : t))
  }

  async function reorderMilestone(id: number, sortOrder: number) {
    const updated = await milestonesApi.reorder(id, sortOrder)
    setMilestones(updated.slice().sort((a, b) => a.sort_order - b.sort_order))
  }

  async function addTask(input: CreateTaskInput) {
    const t = await tasksApi.create(projectId, input)
    setTasks(prev => [...prev, t])
  }

  async function updateTask(id: number, input: UpdateTaskInput) {
    const updated = await tasksApi.update(id, input)
    setTasks(prev => prev.map(t => t.id === id ? updated : t))
  }

  async function deleteTask(id: number) {
    await tasksApi.delete(id)
    setTasks(prev => prev.filter(t => t.id !== id))
  }

  async function reorderTask(id: number, sortOrder: number, scoped: boolean) {
    const affected = await tasksApi.reorder(id, sortOrder, scoped)
    const affectedIds = new Set(affected.map(t => t.id))
    setTasks(prev => [
      ...prev.filter(t => !affectedIds.has(t.id)),
      ...affected,
    ].sort((a, b) => a.sort_order - b.sort_order))
  }

  async function assignUser(taskId: number, userId: number) {
    const updated = await tasksApi.assign(taskId, userId)
    setTasks(prev => prev.map(t => t.id === taskId ? updated : t))
  }

  async function unassignUser(taskId: number, userId: number) {
    await tasksApi.unassign(taskId, userId)
    setTasks(prev => prev.map(t =>
      t.id === taskId
        ? { ...t, assignees: t.assignees.filter(a => a.user_id !== userId) }
        : t
    ))
  }

  async function addMember(member: ProjectMember) {
    await projectsApi.addMember(projectId, member.user_id, member.role)
    setMembers(prev => [...prev, member])
  }

  async function removeMember(userId: number) {
    await projectsApi.removeMember(projectId, userId)
    setMembers(prev => prev.filter(m => m.user_id !== userId))
  }

  async function updateMemberRole(userId: number, role: string) {
    await projectsApi.updateMemberRole(projectId, userId, role)
    setMembers(prev => prev.map(m => m.user_id === userId ? { ...m, role } : m))
  }

  return (
    <ProjectContext.Provider value={{
      project, projectId, milestones, tasks, members, loading,
      selectedTaskId, setSelectedTaskId,
      updateProject,
      addMilestone, updateMilestone, deleteMilestone, reorderMilestone,
      addTask, updateTask, deleteTask, reorderTask,
      assignUser, unassignUser,
      addMember, removeMember, updateMemberRole,
    }}>
      {children}
    </ProjectContext.Provider>
  )
}

export function useProject(): ProjectContextType {
  const ctx = useContext(ProjectContext)
  if (!ctx) throw new Error('useProject must be used within ProjectProvider')
  return ctx
}
