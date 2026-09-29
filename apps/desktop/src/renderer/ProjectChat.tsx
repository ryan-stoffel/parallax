import { Composer } from "./Composer";
import type { Host } from "./hosts";
import type { Project } from "./placeholder";
import { RunTargetMenu } from "./RunTargetMenu";
import { projectIcons } from "./Sidebar";

/**
 * A Project's coordinator chat. Until it has messages (RYA-46), the Project introduces itself:
 * its icon, name, and when it was last active.
 */
export function ProjectChat({
  project,
  host,
  hosts,
}: {
  project: Project;
  host: Host;
  hosts: Host[];
}) {
  const { Icon, color } = projectIcons[project.icon];
  return (
    <>
      <div className="flex flex-1 flex-col items-center justify-center px-8 pb-[8vh] text-center">
        <Icon aria-hidden className={`size-10 ${color}`} />
        <h2 className="mt-5 text-[18px] font-medium tracking-tight">{project.name}</h2>
        <p className="mt-2 max-w-sm text-[14px] text-muted-foreground">
          Agents working on {project.name} report back and coordinate here.
        </p>
        <p className="mt-8 text-[12.5px] text-faint-foreground">Last active {project.age} ago</p>
      </div>
      <div className="mx-auto w-full max-w-3xl px-6 pb-5">
        <Composer tab={<RunTargetMenu hosts={hosts} hostId={host.id} />} />
      </div>
    </>
  );
}
