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

    @patch.object(benchmark, "api")
    def test_cleanup_deletes_only_exact_benchmark_names(self, mocked_api):
        mocked_api.side_effect = [
            {
                "activeWorkspaceId": "target-control",
                "workspaces": [
                    {"id": "keep", "name": "normal"},
                    {"id": "target-hot", "name": "bench-661-run-hot"},
                    {"id": "target-control", "name": "bench-661-run-control"},
                    {"id": "similar", "name": "bench-661-run-hot-old"},
                ],
            },
            {},
            {},
            {},
        ]

        benchmark.cleanup_named_workspaces(
            {"bench-661-run-hot", "bench-661-run-control"}
        )

        self.assertEqual(
            mocked_api.call_args_list,
            [
                unittest.mock.call("GET", "/workspaces"),
                unittest.mock.call("POST", "/workspaces/active", {"id": "keep"}),
                unittest.mock.call("DELETE", "/workspaces/target-control"),
                unittest.mock.call("DELETE", "/workspaces/target-hot"),
            ],
        )


if __name__ == "__main__":
    unittest.main()
