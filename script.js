/**
 * Based heavily on the excellent blogpost from Philipp Bazun:
 *
 * https://web.archive.org/web/20240203155713/https://www.bazun.me/blog/kiterboard/#reversing-bluetooth
 *
 */

const MAX_BLUETOOTH_MESSAGE_SIZE = 20;
const MESSAGE_BODY_MAX_LENGTH = 255;
const PACKET_MIDDLE = 81;
const PACKET_FIRST = 82;
const PACKET_LAST = 83;
const PACKET_ONLY = 84;
const SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const CHARACTERISTIC_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const BLUETOOTH_UNDEFINED = "navigator.bluetooth is undefined";
const BLUETOOTH_CANCELLED = "User cancelled the requestDevice() chooser.";

let bluetoothDevice = null;

function checksum(data) {
  let i = 0;
  for (const value of data) {
    i = (i + value) & 255;
  }
  return ~i & 255;
}

function wrapBytes(data) {
  if (data.length > MESSAGE_BODY_MAX_LENGTH) {
    return [];
  }

  return [1, data.length, checksum(data), 2, ...data, 3];
}

function encodePosition(position) {
  const position1 = position & 255;
  const position2 = (position & 65280) >> 8;
  return [position1, position2];
}

function encodeColor(color) {
  const substring = color.substring(0, 2);
  const substring2 = color.substring(2, 4);

  const parsedSubstring = parseInt(substring, 16) / 32;
  const parsedSubstring2 = parseInt(substring2, 16) / 32;
  const parsedResult = (parsedSubstring << 5) | (parsedSubstring2 << 2);

  const substring3 = color.substring(4, 6);
  const parsedSubstring3 = parseInt(substring3, 16) / 64;
  const finalParsedResult = parsedResult | parsedSubstring3;

  return finalParsedResult;
}

function encodePositionAndColor(position, ledColor) {
  return [...encodePosition(position), encodeColor(ledColor)];
}

function getBluetoothPacket(frames, placementPositions, colors) {
  const resultArray = [];
  let tempArray = [PACKET_MIDDLE];
  frames.split("p").forEach((frame) => {
    if (frame.length > 0) {
      const [placement, role] = frame.split("r");
      const encodedFrame = encodePositionAndColor(
        Number(placementPositions[placement]),
        colors[role] || role
      );
      if (tempArray.length + 3 > MESSAGE_BODY_MAX_LENGTH) {
        resultArray.push(tempArray);
        tempArray = [PACKET_MIDDLE];
      }
      tempArray.push(...encodedFrame);
    }
  });

  resultArray.push(tempArray);

  if (resultArray.length === 1) {
    resultArray[0][0] = PACKET_ONLY;
  } else if (resultArray.length > 1) {
    resultArray[0][0] = PACKET_FIRST;
    resultArray[resultArray.length - 1][0] = PACKET_LAST;
  }

  const finalResultArray = [];
  for (const currentArray of resultArray) {
    finalResultArray.push(...wrapBytes(currentArray));
  }

  return Uint8Array.from(finalResultArray);
}

function splitEvery(n, list) {
  if (n <= 0) {
    throw new Error("First argument to splitEvery must be a positive integer");
  }
  var result = [];
  var idx = 0;
  while (idx < list.length) {
    result.push(list.slice(idx, (idx += n)));
  }
  return result;
}

function illuminateClimb(board, bluetoothPacket) {
  const capitalizedBoard = board[0].toUpperCase() + board.slice(1);
  requestDevice(capitalizedBoard)
    .then((device) => {
      return device.gatt.connect();
    })
    .then((server) => {
      return server.getPrimaryService(SERVICE_UUID);
    })
    .then((service) => {
      return service.getCharacteristic(CHARACTERISTIC_UUID);
    })
    .then((characteristic) => {
      const splitMessages = (buffer) =>
        splitEvery(MAX_BLUETOOTH_MESSAGE_SIZE, buffer).map(
          (arr) => new Uint8Array(arr)
        );
      return writeCharacteristicSeries(
        characteristic,
        splitMessages(bluetoothPacket)
      );
    })
    .then(() => console.log("Climb illuminated"))
    .catch((error) => {
      if (error.message !== BLUETOOTH_CANCELLED) {
        const message =
          error.message === BLUETOOTH_UNDEFINED
            ? "Web Bluetooth is not supported on this browser. See https://caniuse.com/web-bluetooth for more information."
            : `Failed to connect to LEDS: ${error}`;
        alert(message);
      }
    });
}

async function writeCharacteristicSeries(characteristic, messages) {
  let returnValue = null;
  for (const message of messages) {
    returnValue = await characteristic.writeValue(message);
  }
  return returnValue;
}

async function requestDevice(namePrefix) {
  if (!bluetoothDevice) {
    bluetoothDevice = await navigator.bluetooth.requestDevice({
      filters: [
        {
          namePrefix,
        },
      ],
      optionalServices: [SERVICE_UUID],
    });
  }
  return bluetoothDevice;
}

// --- UI Logic ---

const container = document.getElementById('setter-holds-container');
const colorPicker = document.getElementById('color-picker');
const btnClearAll = document.getElementById('btn-clear-all');
const btnLightUp = document.getElementById('btn-light-up');

// State: map of holdId (string) -> hexColor (string, e.g., "FF0000")
let state = {};
let isDrawing = false;

document.addEventListener('mouseup', () => {
    isDrawing = false;
});

function render() {
    if (container.children.length > 0) return;

    if (typeof holdPositions === 'undefined') {
        console.error("holdPositions not found. Make sure kilterboard-data.js is loaded.");
        return;
    }

    for (const [id, pos] of Object.entries(holdPositions)) {
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        const x = pos.x * X_SPACING;
        const y = IMG_HEIGHT - pos.y * Y_SPACING;
        
        circle.setAttribute("cx", x);
        circle.setAttribute("cy", y);
        circle.setAttribute("r", 28);
        circle.setAttribute("stroke-width", 5);
        circle.setAttribute("data-id", id);
        circle.style.cursor = "pointer";
        circle.setAttribute("fill", "transparent");
        // Check if state already has this hold (e.g. from URL)
        if (state[id]) {
            circle.setAttribute("stroke", "#" + state[id]);
        } else {
            circle.setAttribute("stroke", "transparent");
        }

        circle.addEventListener("mousedown", (e) => {
            e.preventDefault();
            isDrawing = true;
            
            // Toggle logic: if already this color, remove it. If different color or empty, set it.
            const currentColor = state[id];
            const selectedColor = colorPicker.value.substring(1).toUpperCase(); // Remove #

            if (currentColor === selectedColor) {
                delete state[id];
                circle.setAttribute("stroke", "transparent");
            } else {
                state[id] = selectedColor;
                circle.setAttribute("stroke", "#" + selectedColor);
            }
        });

        circle.addEventListener("mouseenter", () => {
            if (isDrawing) {
                const selectedColor = colorPicker.value.substring(1).toUpperCase(); // Remove #
                state[id] = selectedColor;
                circle.setAttribute("stroke", "#" + selectedColor);
            }
        });

        container.appendChild(circle);
    }
}

btnClearAll.addEventListener('click', () => {
    state = {};
    const circles = container.querySelectorAll('circle');
    circles.forEach(c => c.setAttribute("stroke", "transparent"));
});

btnLightUp.addEventListener('click', () => {
    // Construct frames string
    // Format: p<id>r<role>...
    // Here role is the hex color string
    let frames = "";
    for (const [id, color] of Object.entries(state)) {
        frames += "p" + id + "r" + color;
    }

    if (frames === "") {
        alert("Select some holds first!");
        return;
    }

    // KILTER_POSITIONS is in kilterboard-data.js
    const bluetoothPacket = getBluetoothPacket(
        frames,
        KILTER_POSITIONS, 
        {} // No predefined colors needed if we pass hex directly
    );
    
    illuminateClimb("Kilter", bluetoothPacket);
});

// --- Image Upload Logic ---

const imageUpload = document.getElementById('image-upload');
const btnUploadTrigger = document.getElementById('btn-upload-trigger');

btnUploadTrigger.addEventListener('click', () => {
    imageUpload.click();
});

imageUpload.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
            processImage(img);
        };
        img.src = event.target.result;
    };
    reader.readAsDataURL(file);
});

function processImage(img) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    // We want to map the image to the board dimensions
    canvas.width = IMG_WIDTH;
    canvas.height = IMG_HEIGHT;
    
    // Draw image to cover the canvas
    ctx.drawImage(img, 0, 0, IMG_WIDTH, IMG_HEIGHT);
    
    // Clear current state
    state = {};
    
    // Iterate over all holds
    for (const [id, pos] of Object.entries(holdPositions)) {
        const x = Math.floor(pos.x * X_SPACING);
        const y = Math.floor(IMG_HEIGHT - pos.y * Y_SPACING);
        
        // Check bounds
        if (x < 0 || x >= IMG_WIDTH || y < 0 || y >= IMG_HEIGHT) continue;

        // Get pixel data at hold position
        const pixel = ctx.getImageData(x, y, 1, 1).data;
        const r = pixel[0];
        const g = pixel[1];
        const b = pixel[2];
        const a = pixel[3];
        
        // Simple threshold to decide if hold should be lit
        // If it's not transparent and has some brightness
        // We can adjust this threshold. 
        // Let's say if brightness (average of RGB) is > 30
        const brightness = (r + g + b) / 3;
        
        if (a > 128 && brightness > 30) {
            // Convert RGB to Hex
            const hex = ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
            state[id] = hex;
        }
    }
    
    // Update UI
    const circles = container.querySelectorAll('circle');
    circles.forEach(c => {
        const id = c.getAttribute('data-id');
        if (state[id]) {
            c.setAttribute("stroke", "#" + state[id]);
        } else {
            c.setAttribute("stroke", "transparent");
        }
    });
}

// --- Share / URL Logic ---

const btnShare = document.getElementById('btn-share');

if (btnShare) {
    btnShare.addEventListener('click', () => {
        const serialized = Object.entries(state)
            .map(([id, color]) => `${id}:${color}`)
            .join(',');
        
        const url = new URL(window.location);
        if (serialized) {
            url.searchParams.set('boulder', serialized);
        } else {
            url.searchParams.delete('boulder');
        }
        window.history.pushState({}, '', url);
        
        navigator.clipboard.writeText(url.toString())
            .then(() => alert("URL copied to clipboard!"))
            .catch(() => alert("URL updated in address bar."));
    });
}

function loadFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const boulderData = params.get('boulder');
    
    if (boulderData) {
        state = {};
        const pairs = boulderData.split(',');
        for (const pair of pairs) {
            const [id, color] = pair.split(':');
            if (id && color) {
                state[id] = color;
            }
        }
    }
}

// Initialize
function init() {
    loadFromUrl();
    render();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
