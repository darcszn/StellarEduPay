# PaymentForm: Show Payment History After Lookup

Closes #229

## Summary

After a parent looked up a student, they saw payment instructions but no history of past payments. `GET /api/payments/:studentId` existed but was never called from the frontend. This PR wires it up and renders results using the existing `TransactionCard` component.

## Changes

### Modified Files

| File | Description |
| ---- | ----------- |
| [`frontend/src/components/PaymentForm.jsx`](frontend/src/components/PaymentForm.jsx) | Fetches payment history in `handleSubmit`, renders it below instructions |

## Implementation

`getStudentPayments` is added to the existing `Promise.all` in `handleSubmit` so all three requests fire in parallel — no extra loading time:

```js
const [stuRes, instrRes, paymentsRes] = await Promise.all([
  getStudent(studentId),
  getPaymentInstructions(studentId),
  getStudentPayments(studentId),
]);
```

Results are rendered with `<TransactionCard />`. An empty array shows "No payments recorded yet."

## Acceptance Criteria

- [x] Payment history is displayed after a successful student lookup
- [x] Each payment shows hash, amount, and date
- [x] Empty state is handled gracefully
