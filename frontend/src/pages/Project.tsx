import { useParams } from 'react-router-dom';

export default function Project() {
  const { id } = useParams<{ id: string }>();

  return (
    <div className="min-h-screen bg-slate-900 text-white p-8">
      <h1 className="text-2xl font-bold">Project {id}</h1>
      <p className="text-slate-400 mt-2">Milestones and tasks will appear here.</p>
    </div>
  );
}
