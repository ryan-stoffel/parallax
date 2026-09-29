import { Folder, GitBranch } from "lucide-react";

import type { Project } from "../protocol/generated/protocol";
import { Composer, tabItem } from "./Composer";
import { ProjectIcon } from "./Sidebar";

/**
 * A Project's coordinator chat. Until RYA-46 wires the coordinator, the Project introduces
 * itself, its composer's tab shows its repository and branch, and the composer stays off.
 */
export function ProjectChat({ project }: { project: Project }) {
  return (
    <>
      <div className="flex flex-1 flex-col items-center justify-center px-8 pb-[8vh] text-center">
        <ProjectIcon className="size-10" />
        <h2 className="mt-5 text-[18px] font-medium tracking-tight">{project.name}</h2>
        <p className="mt-2 max-w-sm text-[14px] text-muted-foreground">
          Agents working on {project.name} report back and coordinate here.
        </p>
      </div>
      <div className="mx-auto w-full max-w-3xl px-6 pb-5">
        <Composer
          disabledReason="Chatting with a Project's coordinator isn't available yet"
          tab={
            <>
              <span className={tabItem} title={project.repoPath}>
                <Folder aria-hidden />
                <span className="truncate">{project.repoPath}</span>
              </span>
              {project.branch && (
                <span className={tabItem}>
                  <GitBranch aria-hidden />
                  {project.branch}
                </span>
              )}
            </>
          }
        />
      </div>
    </>
  );
}
