/*
 * app.js
 *
 * This file contains all of the client‑side logic for the Timekeeper app. It
 * handles user authentication, punch in/out functionality, data retrieval
 * and manipulation, and dynamic rendering of the admin and employee
 * dashboards. When running on GitHub Pages, this file operates entirely in
 * the browser and communicates with Firebase Firestore (or a mock in
 * development) via the Firebase SDK.
 */


/**
 * Toggle this flag to `true` to run against a local in‑memory store instead
 * of Firebase. This makes it possible to test the app without an internet
 * connection or configured Firebase project. When deploying the app for
 * production, leave this set to `false`.
 */
// If this code is being served from a local file (protocol `file:`) we
// automatically enable the mock database. When deployed to GitHub Pages
// or any HTTP(S) server, the real Firestore backend will be used by
// default. To override manually in development, set `window.useMock`
// explicitly in the browser console prior to loading this script.
window.useMock = window.useMock || (
  typeof location !== 'undefined' &&
  (
    location.protocol === 'file:' ||
    location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1'
  )
);

// Global variables for database access and pay period tracking
let db = null;
let payPeriodStartDate = null; // stored as ISO date string (YYYY‑MM‑DD)

/**
 * An in‑memory mock implementation of a subset of the Firebase Firestore API.
 * Only the methods used by this application are implemented. Data is stored
 * in plain JavaScript objects. When running the app with `window.useMock`
 * set to `true`, all reads and writes occur against this mock instead of
 * Firebase.
 */
class MockFirestore {
  constructor() {
    this.collections = {};
  }
  collection(name) {
    if (!this.collections[name]) {
      this.collections[name] = {};
    }
    const collectionData = this.collections[name];
    return {
      doc: (id) => {
        return {
          async get() {
            const data = collectionData[id];
            return {
              exists: !!data,
              data: () => (data ? { ...data } : undefined),
              id
            };
          },
          async set(newData) {
            collectionData[id] = { ...newData };
          },
          async update(updateData) {
            if (!collectionData[id]) {
              throw new Error(`Document ${id} does not exist`);
            }
            collectionData[id] = { ...collectionData[id], ...updateData };
          },
          async delete() {
            delete collectionData[id];
          }
        };
      },
      async get() {
        // Return all documents in this collection
        const docs = Object.keys(collectionData).map((docId) => {
          return {
            id: docId,
            data: () => ({ ...collectionData[docId] })
          };
        });
        return { docs };
      },
      where: (field, op, value) => {
        return {
          async get() {
            const result = [];
            Object.keys(collectionData).forEach((docId) => {
              const doc = collectionData[docId];
              const fieldVal = doc[field];
              let match = false;
              if (op === '==') {
                match = fieldVal === value;
              }
              if (match) {
                result.push({ id: docId, data: () => ({ ...doc }) });
              }
            });
            return { docs: result };
          }
        };
      }
    };
  }
}

/**
 * Initialise the Firestore connection. If `window.useMock` is true then
 * initialise an in‑memory database instead. On real Firebase, this will
 * initialise a new app instance using the configuration provided via
 * firebaseConfig.js.
 */
async function initDatabase() {
  if (window.useMock) {
    db = new MockFirestore();
    // Populate mock data with default settings and a few users. We compute
    // password hashes on the fly using the same hashPassword function used
    // during login. This ensures parity between mock and real modes.
    const adminHash = await hashPassword('admin');
    const aliceHash = await hashPassword('password1');
    const bobHash = await hashPassword('password2');
    // Settings
    db.collection('settings').doc('config').set({ payPeriodStart: getISODateString(new Date()) });
    // Users
    db.collection('users').doc('admin').set({
      username: 'admin',
      role: 'admin',
      hourlyRate: 0,
      passwordHash: adminHash
    });
    db.collection('users').doc('alice').set({
      username: 'alice',
      role: 'employee',
      hourlyRate: 20,
      passwordHash: aliceHash
    });
    db.collection('users').doc('bob').set({
      username: 'bob',
      role: 'employee',
      hourlyRate: 22,
      passwordHash: bobHash
    });
    // Example shift for demonstration. Alice worked 8 hours yesterday.
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yDate = getISODateString(yesterday);
    const docId = `alice_${yDate}`;
    db.collection('shifts').doc(docId).set({
      username: 'alice',
      date: yDate,
      timeIn: `${yDate}T09:00`,
      timeOut: `${yDate}T17:00`,
      adjTimeIn: '',
      adjTimeOut: ''
    });
  } else {
    // Initialise Firebase
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
  }
  // Load the pay period start date into a global variable
  const settingsDoc = await db.collection('settings').doc('config').get();
  if (settingsDoc.exists) {
    const data = settingsDoc.data();
    payPeriodStartDate = data.payPeriodStart;
  }
}

/**
 * Compute the SHA‑256 hash of the provided password and return a hex
 * representation. This function is used both for login validation and for
 * generating hashes in the mock data initialisation. It relies on the Web
 * Crypto API which is supported in modern browsers.
 *
 * @param {string} password
 * @returns {Promise<string>} hex encoded hash
 */
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

/**
 * Return today's date as an ISO string (YYYY-MM-DD). This helper strips the
 * time component, making it useful for shift document keys and date
 * comparison.
 *
 * @param {Date} date Optional date object; defaults to current date
 * @returns {string} ISO date string
 */
function getISODateString(date = new Date()) {
  const tzOffset = date.getTimezoneOffset() * 60000;
  const localDate = new Date(date.getTime() - tzOffset);
  return localDate.toISOString().split('T')[0];
}

/**
 * Retrieve the current session from localStorage. Returns null if no
 * session is stored.
 */
function getSession() {
  const json = localStorage.getItem('session');
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

/**
 * Persist the session object to localStorage.
 * @param {object} session
 */
function saveSession(session) {
  localStorage.setItem('session', JSON.stringify(session));
}

/**
 * Clear the current session and return the user to the login page.
 */
function logout() {
  localStorage.removeItem('session');
  window.location.href = 'index.html';
}

/**
 * Initialise the login form page. Wires up the submit handler for the
 * username/password fields. If a session already exists in storage then the
 * user is redirected directly to the dashboard.
 */
async function initLoginPage() {
  const session = getSession();
  if (session) {
    // If already logged in, go straight to dashboard
    window.location.href = 'dashboard.html';
    return;
  }
  await initDatabase();
  const form = document.getElementById('loginForm');
  const message = document.getElementById('loginMessage');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    message.textContent = '';
    try {
      const hashed = await hashPassword(password);
      const userDoc = await db.collection('users').doc(username).get();
      if (!userDoc.exists) {
        message.textContent = 'Invalid username or password.';
        return;
      }
      const userData = userDoc.data();
      if (userData.passwordHash !== hashed) {
        message.textContent = 'Invalid username or password.';
        return;
      }
      // Successful login
      saveSession({ username: userData.username, role: userData.role });
      window.location.href = 'dashboard.html';
    } catch (err) {
      console.error(err);
      message.textContent = 'Error logging in. See console for details.';
    }
  });
}

/**
 * Initialise the dashboard page. Decides whether to render the admin or
 * employee dashboard based on the role stored in the session.
 */
async function initDashboardPage() {
  const session = getSession();
  if (!session) {
    // If not logged in, redirect to login
    window.location.href = 'index.html';
    return;
  }
  await initDatabase();
  if (session.role === 'admin') {
    await renderAdminDashboard(session.username);
  } else {
    await renderEmployeeDashboard(session.username);
  }
}

/**
 * Render the admin dashboard. Provides controls for selecting employees,
 * adjusting shifts, updating pay periods and hourly rates, and exporting
 * data. Pass the currently logged in admin username for greeting.
 *
 * @param {string} adminUsername
 */
async function renderAdminDashboard(adminUsername) {
  const container = document.getElementById('dashboard');
  container.innerHTML = '';
  const header = document.createElement('h2');
  header.textContent = `Admin Dashboard`;
  container.appendChild(header);
  const greeting = document.createElement('p');
  greeting.textContent = `Hello, ${adminUsername}.`;
  container.appendChild(greeting);
  // Logout button
  const logoutBtn = document.createElement('button');
  logoutBtn.textContent = 'Logout';
  logoutBtn.addEventListener('click', logout);
  container.appendChild(logoutBtn);
  // Fetch list of employees
  const employeeSelect = document.createElement('select');
  const employeesData = await getAllEmployees();
  if (employeesData.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No employees';
    employeeSelect.appendChild(opt);
  } else {
    employeesData.forEach((emp) => {
      const opt = document.createElement('option');
      opt.value = emp.username;
      opt.textContent = emp.username;
      employeeSelect.appendChild(opt);
    });
  }
  // Section: Pay period start date control
  const periodSection = document.createElement('div');
  periodSection.style.marginTop = '20px';
  const periodLabel = document.createElement('label');
  periodLabel.textContent = 'Pay period start date:';
  periodLabel.style.marginRight = '10px';
  const periodInput = document.createElement('input');
  periodInput.type = 'date';
  periodInput.value = payPeriodStartDate || getISODateString();
  periodInput.addEventListener('change', async () => {
    await updatePayPeriodStart(periodInput.value);
  });
  periodSection.appendChild(periodLabel);
  periodSection.appendChild(periodInput);
  container.appendChild(periodSection);
  // Section: Add employee form
  const addSection = document.createElement('div');
  addSection.style.marginTop = '20px';
  const addHeading = document.createElement('h3');
  addHeading.textContent = 'Add New Employee';
  addSection.appendChild(addHeading);
  const addForm = document.createElement('form');
  addForm.classList.add('form');
  addForm.innerHTML = `
    <label for="newUsername">Username</label>
    <input type="text" id="newUsername" name="newUsername" required>
    <label for="newPassword">Password</label>
    <input type="password" id="newPassword" name="newPassword" required>
    <label for="newRate">Hourly Rate</label>
    <input type="number" id="newRate" name="newRate" min="0" step="0.01" required>
    <button type="submit">Add Employee</button>
  `;
  const addMessage = document.createElement('p');
  addMessage.classList.add('message');
  addForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    addMessage.textContent = '';
    const uname = addForm.querySelector('#newUsername').value.trim();
    const pwd = addForm.querySelector('#newPassword').value;
    const rate = parseFloat(addForm.querySelector('#newRate').value);
    if (!uname || !pwd) {
      addMessage.textContent = 'Please enter a username and password.';
      return;
    }
    const exists = await db.collection('users').doc(uname).get();
    if (exists.exists) {
      addMessage.textContent = 'Username already exists.';
      return;
    }
    await addEmployee(uname, pwd, rate);
    addMessage.style.color = 'green';
    addMessage.textContent = `Employee ${uname} added.`;
    // Refresh employee list
    const empOpts = employeeSelect.querySelectorAll('option');
    empOpts.forEach(opt => opt.remove());
    const updatedEmployees = await getAllEmployees();
    updatedEmployees.forEach(emp => {
      const opt = document.createElement('option');
      opt.value = emp.username;
      opt.textContent = emp.username;
      employeeSelect.appendChild(opt);
    });
  });
  addSection.appendChild(addForm);
  addSection.appendChild(addMessage);
  container.appendChild(addSection);
  // Section: Select employee to view details
  const selectSection = document.createElement('div');
  selectSection.style.marginTop = '20px';
  const selectLabel = document.createElement('label');
  selectLabel.textContent = 'Select employee:';
  selectLabel.style.marginRight = '10px';
  selectSection.appendChild(selectLabel);
  selectSection.appendChild(employeeSelect);
  container.appendChild(selectSection);
  // Placeholder for employee details
  const detailsDiv = document.createElement('div');
  detailsDiv.id = 'employeeDetails';
  detailsDiv.style.marginTop = '20px';
  container.appendChild(detailsDiv);
  // When employee selection changes, render details
  employeeSelect.addEventListener('change', async () => {
    if (employeeSelect.value) {
      await renderEmployeeDetails(employeeSelect.value);
    } else {
      detailsDiv.innerHTML = '';
    }
  });
  // Automatically select first employee if available
  if (employeesData.length > 0) {
    employeeSelect.value = employeesData[0].username;
    await renderEmployeeDetails(employeesData[0].username);
  }
}

/**
 * Render the detail view for a single employee within the admin dashboard.
 * This includes the ability to modify adjusted times, change the hourly
 * rate, delete the employee, navigate pay periods, and export CSV reports.
 *
 * @param {string} username
 */
async function renderEmployeeDetails(username) {
  const detailsDiv = document.getElementById('employeeDetails');
  detailsDiv.innerHTML = '';
  // Get user data
  const userDoc = await db.collection('users').doc(username).get();
  if (!userDoc.exists) {
    detailsDiv.textContent = 'Employee not found.';
    return;
  }
  const userData = userDoc.data();
  // Keep track of current period index for navigation
  let currentPeriodIndex = 0;
  // Container for navigation and summary
  const header = document.createElement('h3');
  header.textContent = `Details for ${username}`;
  detailsDiv.appendChild(header);
  // Hourly rate change
  const rateDiv = document.createElement('div');
  rateDiv.style.marginBottom = '10px';
  const rateLabel = document.createElement('label');
  rateLabel.textContent = 'Hourly Rate:';
  rateLabel.style.marginRight = '10px';
  const rateInput = document.createElement('input');
  rateInput.type = 'number';
  rateInput.min = '0';
  rateInput.step = '0.01';
  rateInput.value = userData.hourlyRate;
  const rateButton = document.createElement('button');
  rateButton.textContent = 'Update Rate';
  rateButton.addEventListener('click', async () => {
    const newRate = parseFloat(rateInput.value);
    if (isNaN(newRate) || newRate < 0) {
      alert('Please enter a valid hourly rate.');
      return;
    }
    await db.collection('users').doc(username).update({ hourlyRate: newRate });
    alert('Hourly rate updated.');
    // Refresh table to recalc totals
    await updateTable();
  });
  rateDiv.appendChild(rateLabel);
  rateDiv.appendChild(rateInput);
  rateDiv.appendChild(rateButton);
  detailsDiv.appendChild(rateDiv);
  // Delete employee button
  const deleteBtn = document.createElement('button');
  deleteBtn.textContent = 'Delete Employee';
  deleteBtn.style.marginBottom = '10px';
  deleteBtn.style.backgroundColor = '#dc3545';
  deleteBtn.style.color = '#fff';
  deleteBtn.addEventListener('click', async () => {
    if (confirm(`Are you sure you want to delete ${username}? This will remove all shift records for this employee.`)) {
      await deleteEmployee(username);
      alert(`${username} deleted.`);
      // Remove from list
      const select = document.querySelector('select');
      select.querySelector(`option[value="${username}"]`).remove();
      detailsDiv.innerHTML = '';
    }
  });
  detailsDiv.appendChild(deleteBtn);
  // Navigation controls for pay periods
  const navDiv = document.createElement('div');
  navDiv.style.margin = '10px 0';
  const prevBtn = document.createElement('button');
  prevBtn.textContent = 'Previous Period';
  prevBtn.addEventListener('click', () => {
    currentPeriodIndex--;
    updateTable();
  });
  const nextBtn = document.createElement('button');
  nextBtn.textContent = 'Next Period';
  nextBtn.style.marginLeft = '10px';
  nextBtn.addEventListener('click', () => {
    currentPeriodIndex++;
    updateTable();
  });
  navDiv.appendChild(prevBtn);
  navDiv.appendChild(nextBtn);
  detailsDiv.appendChild(navDiv);
  // Table placeholder
  const tableContainer = document.createElement('div');
  detailsDiv.appendChild(tableContainer);
  // Export CSV
  const exportBtn = document.createElement('button');
  exportBtn.textContent = 'Export CSV';
  exportBtn.style.marginTop = '10px';
  exportBtn.addEventListener('click', async () => {
    await exportCsv(username, currentPeriodIndex);
  });
  detailsDiv.appendChild(exportBtn);
  // Save adjustments
  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save Adjustments';
  saveBtn.style.marginLeft = '10px';
  saveBtn.addEventListener('click', async () => {
    const rows = tableContainer.querySelectorAll('tbody tr');
    for (const row of rows) {
      const docId = row.dataset.docId;
      const adjInVal = row.querySelector('.adj-in').value;
      const adjOutVal = row.querySelector('.adj-out').value;
      // Only update if changed; empty string allowed
      await db.collection('shifts').doc(docId).update({ adjTimeIn: adjInVal || '', adjTimeOut: adjOutVal || '' });
    }
    alert('Adjustments saved.');
    await updateTable();
  });
  detailsDiv.appendChild(saveBtn);
  // Function to update the table for the current period
  async function updateTable() {
    // Clear old table
    tableContainer.innerHTML = '';
    // Load shifts for user
    const shifts = await getShiftsForUser(username);
    // Determine pay period start date for current index
    const baseStart = new Date(payPeriodStartDate);
    const periodStart = new Date(baseStart.getTime());
    periodStart.setDate(periodStart.getDate() + currentPeriodIndex * 14);
    const periodEnd = new Date(periodStart.getTime());
    periodEnd.setDate(periodEnd.getDate() + 13);
    const periodStartISO = getISODateString(periodStart);
    const periodEndISO = getISODateString(periodEnd);
    // Filter shifts in this period
    const periodShifts = shifts.filter(s => s.date >= periodStartISO && s.date <= periodEndISO);
    // Build table
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    thead.innerHTML = `<tr><th>Date</th><th>Day of Week</th><th>Time In</th><th>Manager Adj. In</th><th>Time Out</th><th>Manager Adj. Out</th><th>Hours Worked</th><th>Total Pay</th></tr>`;
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    let totalHours = 0;
    let totalPay = 0;
    for (const shift of periodShifts) {
      const tr = document.createElement('tr');
      tr.dataset.docId = `${shift.username}_${shift.date}`;
      // Date and day of week
      const dateObj = new Date(shift.date + 'T00:00');
      const dayStr = dateObj.toLocaleDateString(undefined, { weekday: 'short' });
      // Determine actual start and end times
      const startTimeStr = shift.timeIn || '';
      const endTimeStr = shift.timeOut || '';
      const adjInStr = shift.adjTimeIn || '';
      const adjOutStr = shift.adjTimeOut || '';
      const actualStartStr = adjInStr || startTimeStr;
      const actualEndStr = adjOutStr || endTimeStr;
      // Compute hours and pay
      let hours = 0;
      let pay = 0;
      if (actualStartStr && actualEndStr) {
        hours = computeHours(actualStartStr, actualEndStr);
        pay = Math.round(hours * userData.hourlyRate * 100) / 100;
        totalHours += hours;
        totalPay += pay;
      }
      tr.innerHTML = `
        <td>${shift.date}</td>
        <td>${dayStr}</td>
        <td>${formatTime(startTimeStr)}</td>
        <td><input class="adj-in" type="time" value="${adjInStr ? formatTimeInput(adjInStr) : ''}"></td>
        <td>${formatTime(endTimeStr)}</td>
        <td><input class="adj-out" type="time" value="${adjOutStr ? formatTimeInput(adjOutStr) : ''}"></td>
        <td>${hours.toFixed(2)}</td>
        <td>${pay.toFixed(2)}</td>
      `;
      tbody.appendChild(tr);
    }
    // Append totals row
    const totalTr = document.createElement('tr');
    totalTr.innerHTML = `<td colspan="6" style="text-align:right;font-weight:bold;">Total:</td><td>${totalHours.toFixed(2)}</td><td>${totalPay.toFixed(2)}</td>`;
    tbody.appendChild(totalTr);
    table.appendChild(tbody);
    tableContainer.appendChild(table);
    // Update navigation button enable/disable based on data availability
    // Disable next button if there are no shifts after this period
    const hasNext = shifts.some(s => s.date > periodEndISO);
    const hasPrev = shifts.some(s => s.date < periodStartISO);
    nextBtn.disabled = !hasNext;
    prevBtn.disabled = !hasPrev;
  }
  // Export CSV for the current period
  async function exportCsv(username, periodIndex) {
    // Use the same filter as updateTable to get the period range
    const shifts = await getShiftsForUser(username);
    const baseStart = new Date(payPeriodStartDate);
    const periodStart = new Date(baseStart.getTime());
    periodStart.setDate(periodStart.getDate() + periodIndex * 14);
    const periodEnd = new Date(periodStart.getTime());
    periodEnd.setDate(periodEnd.getDate() + 13);
    const periodStartISO = getISODateString(periodStart);
    const periodEndISO = getISODateString(periodEnd);
    const periodShifts = shifts.filter(s => s.date >= periodStartISO && s.date <= periodEndISO);
    let csv = 'Date,Day of Week,Time In,Manager Adj. In,Time Out,Manager Adj. Out,Hours Worked,Total Pay\n';
    let totalHours = 0;
    let totalPay = 0;
    for (const shift of periodShifts) {
      const dateObj = new Date(shift.date + 'T00:00');
      const dayStr = dateObj.toLocaleDateString(undefined, { weekday: 'short' });
      const startTimeStr = shift.timeIn || '';
      const endTimeStr = shift.timeOut || '';
      const adjInStr = shift.adjTimeIn || '';
      const adjOutStr = shift.adjTimeOut || '';
      const actualStartStr = adjInStr || startTimeStr;
      const actualEndStr = adjOutStr || endTimeStr;
      let hours = 0;
      let pay = 0;
      if (actualStartStr && actualEndStr) {
        hours = computeHours(actualStartStr, actualEndStr);
        pay = Math.round(hours * userData.hourlyRate * 100) / 100;
        totalHours += hours;
        totalPay += pay;
      }
      csv += `${shift.date},${dayStr},${formatTime(startTimeStr)},${adjInStr ? formatTime(adjInStr) : ''},${formatTime(endTimeStr)},${adjOutStr ? formatTime(adjOutStr) : ''},${hours.toFixed(2)},${pay.toFixed(2)}\n`;
    }
    csv += `Totals,,,,,,${totalHours.toFixed(2)},${totalPay.toFixed(2)}\n`;
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${username}_period_${periodStartISO}_to_${periodEndISO}.csv`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);
  }
  // Kick off first render
  await updateTable();
}

/**
 * Compute the number of hours between two ISO time strings. The result is
 * rounded to two decimal places (nearest minute) as per specification.
 *
 * @param {string} startStr e.g. '2025-08-02T09:00'
 * @param {string} endStr e.g. '2025-08-02T17:15'
 * @returns {number} hours
 */
function computeHours(startStr, endStr) {
  const start = new Date(startStr);
  const end = new Date(endStr);
  const diffMs = end - start;
  if (isNaN(diffMs) || diffMs < 0) return 0;
  const minutes = Math.round(diffMs / 60000); // round to nearest minute
  const hours = minutes / 60;
  return hours;
}

/**
 * Format an ISO date/time string into a human‑friendly HH:MM display. If the
 * input string is falsy or empty, returns an empty string.
 *
 * @param {string} isoStr
 * @returns {string}
 */
function formatTime(isoStr) {
  if (!isoStr) return '';
  const date = new Date(isoStr);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Format an ISO date/time string into a value suitable for a <input type="time">.
 * For example '2025-08-02T09:30' becomes '09:30'.
 * @param {string} isoStr
 * @returns {string}
 */
function formatTimeInput(isoStr) {
  if (!isoStr) return '';
  const date = new Date(isoStr);
  if (isNaN(date.getTime())) return '';
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Load all user documents with the role of 'employee'. Returns an array
 * containing each user's data. Used by the admin dashboard to populate
 * employee selection.
 */
async function getAllEmployees() {
  const result = await db.collection('users').where('role', '==', 'employee').get();
  return result.docs.map((doc) => doc.data());
}

/**
 * Create a new employee account. The password will be hashed before
 * storage. New employees are stored under the 'users' collection with the
 * username as the document ID. Their role is set to 'employee'.
 *
 * @param {string} username
 * @param {string} password
 * @param {number} hourlyRate
 */
async function addEmployee(username, password, hourlyRate) {
  const hash = await hashPassword(password);
  await db.collection('users').doc(username).set({
    username,
    role: 'employee',
    hourlyRate,
    passwordHash: hash
  });
}

/**
 * Delete an employee and all associated shifts. Does not delete pay period
 * data because pay periods are computed on the fly. Used by the admin.
 * @param {string} username
 */
async function deleteEmployee(username) {
  // Delete the user document
  await db.collection('users').doc(username).delete();
  // Delete all shifts for this user
  const shifts = await db.collection('shifts').where('username', '==', username).get();
  for (const doc of shifts.docs) {
    await db.collection('shifts').doc(doc.id).delete();
  }
}

/**
 * Update the global pay period start date. Accepts a string in
 * YYYY‑MM‑DD format. Updates both the settings document in the database
 * and the global `payPeriodStartDate` variable.
 *
 * @param {string} newDate
 */
async function updatePayPeriodStart(newDate) {
  payPeriodStartDate = newDate;
  await db.collection('settings').doc('config').set({ payPeriodStart: newDate });
}

/**
 * Fetch all shift documents for a given user. Returns an array of objects
 * sorted by date ascending. Each object contains the shift data and the
 * document ID.
 *
 * @param {string} username
 */
async function getShiftsForUser(username) {
  const result = await db.collection('shifts').where('username', '==', username).get();
  const shifts = result.docs.map((doc) => {
    const data = doc.data();
    return {
      ...data,
      docId: doc.id
    };
  });
  shifts.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return shifts;
}

/**
 * Render the employee dashboard for a given user. Provides punch in/out
 * buttons, displays the user's shift history, and shows pay period totals.
 *
 * @param {string} username
 */
async function renderEmployeeDashboard(username) {
  const container = document.getElementById('dashboard');
  container.innerHTML = '';
  const header = document.createElement('h2');
  header.textContent = 'Employee Dashboard';
  container.appendChild(header);
  const greeting = document.createElement('p');
  greeting.textContent = `Hello, ${username}.`;
  container.appendChild(greeting);
  // Logout button
  const logoutBtn = document.createElement('button');
  logoutBtn.textContent = 'Logout';
  logoutBtn.addEventListener('click', logout);
  container.appendChild(logoutBtn);
  // Determine punch state
  const today = getISODateString();
  const docId = `${username}_${today}`;
  const shiftDoc = await db.collection('shifts').doc(docId).get();
  const hasShift = shiftDoc.exists;
  const shiftData = hasShift ? shiftDoc.data() : null;
  // Buttons container
  const btnDiv = document.createElement('div');
  btnDiv.classList.add('button-group');
  const punchInBtn = document.createElement('button');
  punchInBtn.textContent = 'Punch In';
  const punchOutBtn = document.createElement('button');
  punchOutBtn.textContent = 'Punch Out';
  // Determine which buttons to enable
  if (!hasShift) {
    punchInBtn.disabled = false;
    punchOutBtn.disabled = true;
  } else if (shiftData && shiftData.timeIn && !shiftData.timeOut) {
    punchInBtn.disabled = true;
    punchOutBtn.disabled = false;
  } else {
    punchInBtn.disabled = true;
    punchOutBtn.disabled = true;
  }
  punchInBtn.addEventListener('click', async () => {
    await punchIn(username);
    await renderEmployeeDashboard(username);
  });
  punchOutBtn.addEventListener('click', async () => {
    await punchOut(username);
    await renderEmployeeDashboard(username);
  });
  btnDiv.appendChild(punchInBtn);
  btnDiv.appendChild(punchOutBtn);
  container.appendChild(btnDiv);
  // Load user data for hourly rate
  const userDoc = await db.collection('users').doc(username).get();
  const userData = userDoc.data();
  // Load shifts and render table
  const shifts = await getShiftsForUser(username);
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr><th>Date</th><th>Day</th><th>Time In</th><th>Adj. In</th><th>Time Out</th><th>Adj. Out</th><th>Hours</th><th>Pay</th></tr>`;
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  let totalHours = 0;
  let totalPay = 0;
  // Determine current pay period (index 0) for employee view
  const baseStart = new Date(payPeriodStartDate);
  const todayDate = new Date(today);
  const diffDays = Math.floor((todayDate - baseStart) / (1000 * 60 * 60 * 24));
  const currentIndex = Math.floor(diffDays / 14);
  const periodStart = new Date(baseStart.getTime());
  periodStart.setDate(periodStart.getDate() + currentIndex * 14);
  const periodEnd = new Date(periodStart.getTime());
  periodEnd.setDate(periodEnd.getDate() + 13);
  const periodStartISO = getISODateString(periodStart);
  const periodEndISO = getISODateString(periodEnd);
  for (const shift of shifts) {
    // Only include rows that fall into the current pay period
    if (shift.date < periodStartISO || shift.date > periodEndISO) continue;
    const tr = document.createElement('tr');
    const dateObj = new Date(shift.date + 'T00:00');
    const dayStr = dateObj.toLocaleDateString(undefined, { weekday: 'short' });
    const startTimeStr = shift.timeIn || '';
    const endTimeStr = shift.timeOut || '';
    const adjInStr = shift.adjTimeIn || '';
    const adjOutStr = shift.adjTimeOut || '';
    const actualStartStr = adjInStr || startTimeStr;
    const actualEndStr = adjOutStr || endTimeStr;
    let hours = 0;
    let pay = 0;
    if (actualStartStr && actualEndStr) {
      hours = computeHours(actualStartStr, actualEndStr);
      pay = Math.round(hours * userData.hourlyRate * 100) / 100;
      totalHours += hours;
      totalPay += pay;
    }
    tr.innerHTML = `
      <td>${shift.date}</td>
      <td>${dayStr}</td>
      <td>${formatTime(startTimeStr)}</td>
      <td>${adjInStr ? formatTime(adjInStr) : ''}</td>
      <td>${formatTime(endTimeStr)}</td>
      <td>${adjOutStr ? formatTime(adjOutStr) : ''}</td>
      <td>${hours.toFixed(2)}</td>
      <td>${pay.toFixed(2)}</td>
    `;
    tbody.appendChild(tr);
  }
  const totalTr = document.createElement('tr');
  totalTr.innerHTML = `<td colspan="6" style="text-align:right;font-weight:bold;">Total:</td><td>${totalHours.toFixed(2)}</td><td>${totalPay.toFixed(2)}</td>`;
  tbody.appendChild(totalTr);
  table.appendChild(tbody);
  container.appendChild(table);
  // Display period range
  const periodInfo = document.createElement('p');
  periodInfo.textContent = `Current pay period: ${periodStartISO} to ${periodEndISO}`;
  container.appendChild(periodInfo);
}

/**
 * Create or update today's shift document to record the punch in time. Uses
 * the device's current time. If a shift document already exists for today
 * then this call is ignored.
 *
 * @param {string} username
 */
async function punchIn(username) {
  const date = getISODateString();
  const docId = `${username}_${date}`;
  const docRef = db.collection('shifts').doc(docId);
  const doc = await docRef.get();
  if (doc.exists) {
    const data = doc.data();
    if (data.timeIn) {
      alert('You have already punched in today.');
      return;
    }
  }
  const now = new Date();
  const iso = now.toISOString().substring(0, 16); // up to minutes
  await docRef.set({
    username,
    date,
    timeIn: iso,
    timeOut: '',
    adjTimeIn: '',
    adjTimeOut: ''
  });
}

/**
 * Record the punch out time for today's shift. If no shift document exists
 * or the user has not yet punched in, a message is shown. If the shift
 * already has a timeOut recorded then punching out is not allowed.
 *
 * @param {string} username
 */
async function punchOut(username) {
  const date = getISODateString();
  const docId = `${username}_${date}`;
  const docRef = db.collection('shifts').doc(docId);
  const doc = await docRef.get();
  if (!doc.exists || !doc.data().timeIn) {
    alert('You have not punched in yet today.');
    return;
  }
  if (doc.data().timeOut) {
    alert('You have already punched out today.');
    return;
  }
  const now = new Date();
  const iso = now.toISOString().substring(0, 16);
  await docRef.update({ timeOut: iso });
}

// Auto‑initialise pages based on current location
if (window.location.pathname.endsWith('index.html') || window.location.pathname === '/' || window.location.pathname === '/index.html') {
  // Ensure database is initialised after DOM loads
  document.addEventListener('DOMContentLoaded', initLoginPage);
} else if (window.location.pathname.endsWith('dashboard.html')) {
  document.addEventListener('DOMContentLoaded', initDashboardPage);
}