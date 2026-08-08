import { createContext, useContext, useEffect, useState } from 'react'
import { projects as projectsApi, milestones as milestonesApi, tasks as tasksApi } from '../api/client'
import type { CreateMilestoneInput, UpdateMilestoneInput, CreateTaskInput, UpdateTaskInput } from '../api/client'
import type { ProjectDetail, MilestoneSummary, TaskWithAssignees, ProjectMember } from '../types'

interface ProjectContextType {
  project: ProjectDetail | null
  projectId: number
  milestones: MilestoneSummary[]
  tasks: Record<number, TaskWithAssignees[]>
  members: ProjectMember[]
  loading: boolean
  selectedTaskId: number | null
  setSelectedTaskId: (id: number | null) => void
  addMilestone: (input: CreateMilestoneInput) => Promise<void>
  updateMilestone: (id: number, input: UpdateMilestoneInput) => Promise<void>
  deleteMilestone: (id: number) => Promise<void>
  reorderMilestone: (id: number, sortOrder: number) => Promise<void>
  addTask: (milestoneId: number, input: CreateTaskInput) => Promise<void>
  updateTask: (id: number, milestoneId: number, input: UpdateTaskInput) => Promise<void>
  deleteTask: (id: number, milestoneId: number) => Promise<void>
  reorderTask: (id: number, fromMilestoneId: number, toMilestoneId: number, sortOrder: number) => Promise<void>
  assignUser: (taskId: number, milestoneId: number, userId: number) => Promise<void>
  unassignUser: (taskId: number, milestoneId: number, userId: number) => Promise<void>
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
  const [tasks, setTasks] = useState<Record<number, TaskWithAssignees[]>>({})
  const [members, setMembers] = useState<ProjectMember[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null)

  useEffect(() => {
    Promise.all([
      projectsApi.get(projectId),
      projectsApi.listMembers(projectId),
    ]).then(async ([proj, mems]) => {
      setProject(proj)
      setMembers(mems)
      setMilestones(proj.milestones)
      const taskArrays = await Promise.all(
        proj.milestones.map(m => tasksApi.list(m.id))
      )
      const taskMap: Record<number, TaskWithAssignees[]> = {}
      proj.milestones.forEach((m, i) => { taskMap[m.id] = taskArrays[i] })
      setTasks(taskMap)
    }).finally(() => setLoading(false))
  }, [projectId])

  async function addMilestone(input: CreateMilestoneInput) {
    const m = await milestonesApi.create(projectId, input)
    setMilestones(prev => [...prev, m])
    setTasks(prev => ({ ...prev, [m.id]: [] }))
  }

  async function updateMilestone(id: number, input: UpdateMilestoneInput) {
    const updated = await milestonesApi.update(id, input)
    setMilestones(prev => prev.map(m => m.id === id ? updated : m))
  }

  async function deleteMilestone(id: number) {
    await milestonesApi.delete(id)
    setMilestones(prev => prev.filter(m => m.id !== id))
    setTasks(prev => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  async function reorderMilestone(id: number, sortOrder: number) {
    const updated = await milestonesApi.reorder(id, sortOrder)
    setMilestones(updated.slice().sort((a, b) => a.sort_order - b.sort_order))
  }

  async function addTask(milestoneId: number, input: CreateTaskInput) {
    const t = await tasksApi.create(milestoneId, input)
    setTasks(prev => ({ ...prev, [milestoneId]: [...(prev[milestoneId] ?? []), t] }))
  }

  async function updateTask(id: number, milestoneId: number, input: UpdateTaskInput) {
    const updated = await tasksApi.update(id, input)
    setTasks(prev => ({
      ...prev,
      [milestoneId]: (prev[milestoneId] ?? []).map(t => t.id === id ? updated : t),
    }))
  }

  async function deleteTask(id: number, milestoneId: number) {
    await tasksApi.delete(id)
    setTasks(prev => ({
      ...prev,
      [milestoneId]: (prev[milestoneId] ?? []).filter(t => t.id !== id),
    }))
  }

  async function reorderTask(
    id: number,
    fromMilestoneId: number,
    toMilestoneId: number,
    sortOrder: number,
  ) {
    const updated = await tasksApi.reorder(id, toMilestoneId, sortOrder)
    if (fromMilestoneId === toMilestoneId) {
      setTasks(prev => ({
        ...prev,
        [fromMilestoneId]: (prev[fromMilestoneId] ?? [])
          .map(t => t.id === id ? updated : t)
          .sort((a, b) => a.sort_order - b.sort_order),
      }))
    } else {
      setTasks(prev => ({
        ...prev,
        [fromMilestoneId]: (prev[fromMilestoneId] ?? []).filter(t => t.id !== id),
        [toMilestoneId]: [...(prev[toMilestoneId] ?? []), updated]
          .sort((a, b) => a.sort_order - b.sort_order),
      }))
    }
  }

  async function assignUser(taskId: number, milestoneId: number, userId: number) {
    const updated = await tasksApi.assign(taskId, userId)
    setTasks(prev => ({
      ...prev,
      [milestoneId]: (prev[milestoneId] ?? []).map(t => t.id === taskId ? updated : t),
    }))
  }

  async function unassignUser(taskId: number, milestoneId: number, userId: number) {
    await tasksApi.unassign(taskId, userId)
    setTasks(prev => ({
      ...prev,
      [milestoneId]: (prev[milestoneId] ?? []).map(t =>
        t.id === taskId
          ? { ...t, assignees: t.assignees.filter(a => a.user_id !== userId) }
          : t
      ),
    }))
  }

  return (
    <ProjectContext.Provider value={{
      project, projectId, milestones, tasks, members, loading,
      selectedTaskId, setSelectedTaskId,
      addMilestone, updateMilestone, deleteMilestone, reorderMilestone,
      addTask, updateTask, deleteTask, reorderTask,
      assignUser, unassignUser,
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
