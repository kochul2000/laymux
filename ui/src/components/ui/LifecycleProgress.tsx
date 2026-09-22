import { Check, LoaderCircle } from "lucide-react";
import {
  lifecycleCopy,
  lifecycleSteps,
  progressPercent,
  type ExitProgress,
} from "@/lib/lifecycle-progress";
import "./lifecycle.css";

export function LifecycleProgress({
  kind,
  cleanup,
  progress,
  ko = false,
  failed = false,
}: {
  kind: "close" | "update";
  cleanup: boolean;
  progress: ExitProgress;
  ko?: boolean;
  failed?: boolean;
}) {
  const copy = lifecycleCopy[ko ? "ko" : "en"];
  const steps = lifecycleSteps(kind, cleanup);
  const active = steps.indexOf(progress.stage === "settling" ? "interrupting" : progress.stage);
  const percent = progress.stage === "interrupting" ? null : progressPercent(progress);
  return (
    <ol className="lifecycle-steps" aria-live="polite">
      {steps.map((stage, index) => (
        <li
          key={stage}
          className={`lifecycle-step ${index === active ? "is-active" : ""} ${index < active ? "is-done" : ""}`}
          aria-current={index === active ? "step" : undefined}
        >
          <span className="lifecycle-step-icon">
            {index < active ? (
              <Check size={16} />
            ) : index === active ? (
              <LoaderCircle size={16} className={failed ? "" : "lifecycle-spin"} />
            ) : (
              <span>{index + 1}</span>
            )}
          </span>
          <div className="lifecycle-step-body">
            <span>{copy[stage]}</span>
            {index === active && (
              <>
                <div className="lifecycle-step-detail">
                  {progress.stage === "settling"
                    ? copy.settling
                    : stage === "interrupting"
                      ? copy.interrupted
                      : ""}
                  <span>{percent !== null ? `${percent}%` : ""}</span>
                </div>
                <div
                  className="lifecycle-track"
                  role="progressbar"
                  aria-label={copy[stage]}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent ?? undefined}
                >
                  <div
                    className={
                      percent === null ? "lifecycle-bar is-indeterminate" : "lifecycle-bar"
                    }
                    style={{ width: percent === null ? "35%" : `${percent}%` }}
                  />
                </div>
              </>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
