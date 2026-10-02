# Method notes (kept as-is)

These follow from the algorithm the project asked to preserve. They affect interpretation, not correctness.

1. **In-sample baseline.** `mu_0` and `sigma_0` come from the same series that is monitored. A large swarm inflates both, which lowers sensitivity to exactly the events of interest. A held-out or trailing baseline would be more standard CUSUM practice.
2. **Series span.** Each cell's series covers only its first to last event. Quiet time outside that span is not counted, so `mu_0` is biased upward for cells with a short active period.
3. **No reset after an alarm.** `S_t` keeps accumulating, so one burst produces consecutive alarm rows. `cusum_anomalies.csv` has one row per alarmed time step, not one per episode.
4. **Energy is a proxy.** `10^(1.5 M)` is proportional to radiated energy, not in joules. Only relative comparisons are meaningful.
5. **Equal-angle cells.** A 2 degree cell is much narrower in kilometres near the poles than at the equator.
6. **Catalogue completeness.** Feeds with low magnitude cut-offs are incomplete in remote regions and right after large shocks, which can look like change.
7. **Many cells, no correction.** Hundreds of cells are tested at once; some alarms are expected by chance. This is a screening tool, not a forecast or a hazard model.
