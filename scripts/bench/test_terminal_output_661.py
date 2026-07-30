import unittest

import terminal_output_661 as benchmark


class TerminalOutput661BenchmarkTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
