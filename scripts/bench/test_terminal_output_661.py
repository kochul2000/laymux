import unittest
from unittest.mock import patch

import terminal_output_661 as benchmark


class TerminalOutput661BenchmarkTests(unittest.TestCase):
    @patch.object(benchmark.subprocess, "check_output")
    def test_git_source_changes_ignores_only_known_dev_runtime_files(self, check_output):
        check_output.return_value = (
            "?? src-tauri/automation.json\n"
            "?? src-tauri/settings.json\n"
            " M ui/src/main.tsx\n"
            "?? unexpected.txt\n"
        )

        self.assertEqual(
            benchmark.git_source_changes(benchmark.Path("repo")),
            [" M ui/src/main.tsx", "?? unexpected.txt"],
        )

    def test_percentile_uses_nearest_rank(self):
        values = [5.0, 1.0, 4.0, 2.0, 3.0]
        self.assertEqual(benchmark.percentile(values, 0.50), 3.0)
        self.assertEqual(benchmark.percentile(values, 0.95), 5.0)

    def test_service_gap_counts_only_time_while_backend_is_ahead(self):
        samples = [
            {
                "ok": True,
                "atMs": 100.0,
                "result": {
                    "terminalOutput": [
                        {"terminalId": "t1", "parsedAck": 10, "writeSeq": 20}
                    ]
                },
            },
            {
                "ok": True,
                "atMs": 350.0,
                "result": {
                    "terminalOutput": [
                        {"terminalId": "t1", "parsedAck": 10, "writeSeq": 30}
                    ]
                },
            },
            {
                "ok": True,
                "atMs": 500.0,
                "result": {
                    "terminalOutput": [
                        {"terminalId": "t1", "parsedAck": 30, "writeSeq": 30}
                    ]
                },
            },
        ]
        self.assertEqual(benchmark.longest_backlog_service_gaps(samples, ["t1"]), {"t1": 250.0})

    def test_service_gap_does_not_include_time_between_separate_backlogs(self):
        samples = [
            {
                "ok": True,
                "atMs": 100.0,
                "result": {
                    "terminalOutput": [{"terminalId": "t1", "parsedAck": 10, "writeSeq": 20}]
                },
            },
            {
                "ok": True,
                "atMs": 200.0,
                "result": {
                    "terminalOutput": [{"terminalId": "t1", "parsedAck": 20, "writeSeq": 20}]
                },
            },
            {
                "ok": True,
                "atMs": 1_000.0,
                "result": {
                    "terminalOutput": [{"terminalId": "t1", "parsedAck": 20, "writeSeq": 30}]
                },
            },
            {
                "ok": True,
                "atMs": 1_150.0,
                "result": {
                    "terminalOutput": [{"terminalId": "t1", "parsedAck": 20, "writeSeq": 30}]
                },
            },
        ]

        self.assertEqual(benchmark.longest_backlog_service_gaps(samples, ["t1"]), {"t1": 150.0})

    def test_settled_frontiers_requires_backend_and_frontend_intersection(self):
        snapshot = {
            "terminalOutput": [
                {
                    "terminalId": "t1",
                    "desktopOutputState": "healthy",
                    "reason": None,
                    "parsedAck": 30,
                    "writeSeq": 30,
                    "ringEndSeq": 30,
                    "deliveryObservedSeq": 30,
                }
            ],
            "frontend": {
                "terminalOutputV3": {
                    "t1": {
                        "state": "active",
                        "reason": None,
                        "admittedSeq": 30,
                        "parsedSeq": 30,
                    }
                }
            },
        }

        self.assertIs(benchmark.settled_frontiers(snapshot, ["t1"]), snapshot)
        snapshot["frontend"]["terminalOutputV3"]["t1"]["parsedSeq"] = 29
        self.assertIsNone(benchmark.settled_frontiers(snapshot, ["t1"]))

    def test_minimum_parser_backlog_requires_every_hot_pane(self):
        snapshot = {
            "terminalOutput": [
                {"terminalId": "t1", "parsedAck": 10, "writeSeq": 10 + 65_536},
                {"terminalId": "t2", "parsedAck": 20, "writeSeq": 20 + 65_535},
            ]
        }

        self.assertFalse(benchmark.has_minimum_parser_backlog(snapshot, ["t1", "t2"]))
        snapshot["terminalOutput"][1]["writeSeq"] += 1
        self.assertTrue(benchmark.has_minimum_parser_backlog(snapshot, ["t1", "t2"]))

    def test_pipeline_counter_delta_rejects_attach_or_replay_during_run(self):
        initial = {"t1": {"attaches": 1, "attachReplayBytes": 512}}
        unchanged = {"t1": {"attaches": 1, "attachReplayBytes": 512}}
        replayed = {"t1": {"attaches": 2, "attachReplayBytes": 1_024}}

        self.assertTrue(
            benchmark.pipeline_counters_unchanged(
                initial, unchanged, ["t1"], ["attaches", "attachReplayBytes"]
            )
        )
        self.assertFalse(
            benchmark.pipeline_counters_unchanged(
                initial, replayed, ["t1"], ["attaches", "attachReplayBytes"]
            )
        )
        self.assertFalse(
            benchmark.pipeline_counters_unchanged(
                initial, {}, ["t1"], ["attaches", "attachReplayBytes"]
            )
        )

    def test_ready_terminal_ids_rejects_stale_profile_generation(self):
        instances = [
            {
                "id": "old",
                "workspaceId": "ws",
                "paneIndex": 0,
                "profile": "WSL",
                "sessionReady": True,
            }
        ]

        self.assertIsNone(benchmark.ready_terminal_ids(instances, "ws", 1))
        instances[0]["profile"] = "PowerShell"
        self.assertEqual(benchmark.ready_terminal_ids(instances, "ws", 1), ["old"])

    @patch.object(benchmark, "api")
    def test_buffer_logical_text_rejoins_wrapped_xterm_rows(self, mocked_api):
        mocked_api.return_value = {
            "lines": [
                {"text": "FINAL-run-terminal-", "isWrapped": False},
                {"text": "pane-0001-150000", "isWrapped": True},
                {"text": "next", "isWrapped": False},
            ]
        }

        text = benchmark.buffer_logical_text("terminal-pane-0001")

        self.assertEqual(text, "FINAL-run-terminal-pane-0001-150000\nnext")

    def test_latency_summary_preserves_failures(self):
        summary = benchmark.latency_summary(
            [
                {"ok": True, "latencyMs": 2.0},
                {"ok": False, "latencyMs": 7_000.0},
                {"ok": True, "latencyMs": 4.0},
            ]
        )
        self.assertEqual(summary["successes"], 2)
        self.assertEqual(summary["timeoutsOrErrors"], 1)
        self.assertEqual(summary["maxMs"], 4.0)

    def test_control_acceptance_requires_the_write_request_to_succeed(self):
        self.assertTrue(
            benchmark.control_samples_succeeded(
                [{"write": {"ok": True}, "backendEchoMs": 1.0, "xtermEchoMs": 2.0}]
            )
        )
        self.assertFalse(
            benchmark.control_samples_succeeded(
                [{"write": {"ok": False}, "backendEchoMs": 1.0, "xtermEchoMs": 2.0}]
            )
        )

    def test_guarded_worker_records_unexpected_exception(self):
        failures = []

        def fail():
            raise ValueError("broken sample")

        benchmark.run_guarded_worker("diagnostics", fail, failures)

        self.assertEqual(
            failures,
            [{"worker": "diagnostics", "type": "ValueError", "error": "broken sample"}],
        )

    @patch.object(benchmark, "api")
    def test_cleanup_restores_original_workspace_and_deletes_only_created_ids(self, mocked_api):
        mocked_api.side_effect = [
            {
                "activeWorkspaceId": "target-control",
                "workspaces": [
                    {"id": "original", "name": "normal"},
                    {"id": "target-hot", "name": "bench-661-run-hot"},
                    {"id": "target-control", "name": "bench-661-run-control"},
                    {"id": "same-name", "name": "bench-661-run-hot"},
                ],
            },
            {},
            {},
            {},
            {},
        ]

        benchmark.cleanup_created_workspaces(
            benchmark.BenchmarkResources(
                original_active_workspace_id="original",
                original_focused_terminal_id="original-terminal",
                created_workspace_ids=["target-hot", "target-control"],
            )
        )

        self.assertEqual(
            mocked_api.call_args_list,
            [
                unittest.mock.call("GET", "/workspaces"),
                unittest.mock.call("POST", "/workspaces/active", {"id": "original"}),
                unittest.mock.call("DELETE", "/workspaces/target-control"),
                unittest.mock.call("DELETE", "/workspaces/target-hot"),
                unittest.mock.call("POST", "/terminals/original-terminal/focus"),
            ],
        )


if __name__ == "__main__":
    unittest.main()
