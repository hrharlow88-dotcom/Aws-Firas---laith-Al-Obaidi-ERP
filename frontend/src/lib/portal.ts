/** What employees see and may do in their own portal; the owner decides (owner console). */
export interface PortalSettings {
  card: boolean;
  showManager: boolean;
  showShift: boolean;
  attendance: boolean;
  leaveBalances: boolean;
  leaveRequests: boolean;
  hourlyLeave: boolean;
  payslips: boolean;
  loanRequests: boolean;
  expenseRequests: boolean;
  tickets: boolean;
  notices: boolean;
  photoUpload: boolean;
  welcome: string;
}

export const DEFAULT_PORTAL: PortalSettings = {
  card: true, showManager: true, showShift: true, attendance: true, leaveBalances: true, leaveRequests: true,
  hourlyLeave: true, payslips: true, loanRequests: true, expenseRequests: true, tickets: true, notices: true,
  photoUpload: true, welcome: '',
};
