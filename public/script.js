let labeledFaceDescriptors = [];
let modelsLoaded = false;
let cedulaNombreMap = {}; // Mapa de cédula a nombre
let selectedEmpresaId = null;
let descriptorsCache = {}; // Cache para los descriptores
let loadedUsers = new Set(); // Set para evitar duplicación de usuarios

// Mostrar mensaje de carga
function showLoadingMessage(show) {
    const loadingMessage = document.getElementById('loading-message');
    if (show) {
        loadingMessage.style.display = 'block'; // Mostrar mensaje
    } else {
        loadingMessage.style.display = 'none'; // Ocultar mensaje
    }
}

async function loadModels() {
    const MODEL_URL = '/models';
    await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    modelsLoaded = true;
    console.log("Modelos cargados");
}

// Cargar descriptores de manera progresiva, evitando duplicados y asegurando carga completa de usuarios
async function loadLabeledImagesAsync() {
    if (!selectedEmpresaId) {
        console.error("No se ha seleccionado una empresa");
        return [];
    }

    // Mostrar el mensaje de carga
    showLoadingMessage(true);

    try {
        const response = await fetch(`/get-labels?empresaId=${selectedEmpresaId}`);
        const { labels, totalUsers } = await response.json();

        // Limpiar el array antes de cargar nuevos descriptores
        labeledFaceDescriptors = [];

        // Procesar usuarios en lotes pequeños para evitar sobrecargar la memoria
        const batchSize = 10; // Tamaño del lote
        for (let i = 0; i < labels.length; i += batchSize) {
            const batch = labels.slice(i, i + batchSize); // Obtener el siguiente lote
            await processBatch(batch);
        }

        console.log("Descriptores cargados:", labeledFaceDescriptors);
    } catch (error) {
        console.error("Error al cargar los descriptores desde la base de datos:", error);
    } finally {
        // Ocultar el mensaje de carga
        showLoadingMessage(false);
    }
}

async function processBatch(batch) {
    await Promise.all(
        batch.map(async (label) => {
            if (loadedUsers.has(label)) {
                return; // Si el usuario ya está cargado, saltarlo
            }

            loadedUsers.add(label); // Marcar como cargado

            try {
                const response = await fetch(`/get-image?name=${label}&empresaId=${selectedEmpresaId}`);
                const blob = await response.blob();
                const img = await faceapi.bufferToImage(blob);

                if (!img) {
                    console.error(`No se pudo cargar la imagen para el usuario: ${label}`);
                    return;
                }

                const detections = await faceapi.detectSingleFace(img).withFaceLandmarks().withFaceDescriptor();

                if (detections && detections.descriptor) {
                    const labeledDescriptor = new faceapi.LabeledFaceDescriptors(label, [detections.descriptor]);

                    // Agregar descriptor si no está duplicado
                    if (!labeledFaceDescriptors.some(descriptor => descriptor.label === label)) {
                        labeledFaceDescriptors.push(labeledDescriptor);
                        descriptorsCache[label] = labeledDescriptor; // Guardar en cache
                    }
                } else {
                    console.error(`No se detectó un rostro para el usuario: ${label}`);
                }
            } catch (error) {
                console.error(`Error cargando imagen para ${label}:`, error);
            }
        })
    );
}

function capturePhoto(videoElement) {
    const canvas = document.createElement('canvas');
    // Redimensionamos la imagen capturada a un tamaño pequeño:
    canvas.width = 200; // por ejemplo 200 píxeles
    canvas.height = 200;
    const ctx = canvas.getContext('2d');

    // Redibujamos la imagen del video en el canvas reducido
    ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);

    // Exportamos como JPEG de baja calidad (opcionalmente puedes bajar calidad)
    return canvas.toDataURL('image/jpeg', 0.7); // calidad 70%
}



// Función para activar la cámara y realizar el reconocimiento facial
async function startCamera() {
    if (!modelsLoaded) {
        console.error("Los modelos no se han cargado aún.");
        return;
    }

    const video = document.getElementById('video');

    if (navigator.mediaDevices.getUserMedia) {
        navigator.mediaDevices.getUserMedia({ video: {} })
            .then(function(stream) {
                video.srcObject = stream;
                video.play();
                console.log("Cámara activada");
            })
            .catch(function(error) {
                console.error("Error al activar la cámara: ", error);
            });
    } else {
        console.error("getUserMedia no es soportado en este navegador.");
    }

    video.addEventListener('loadeddata', async () => {
        const canvas = faceapi.createCanvasFromMedia(video);
        canvas.style.position = 'absolute';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        document.getElementById('camera').appendChild(canvas);

        const updateCanvasSize = () => {
            const displaySize = { width: video.clientWidth, height: video.clientHeight };
            faceapi.matchDimensions(canvas, displaySize);
        };

        updateCanvasSize();
        window.addEventListener('resize', updateCanvasSize);

        let previousBox = null;
        let stillFrames = 0;
        let noBlinkFrames = 0;

        function getEyeAspectRatio(eye) {
            const A = faceapi.euclideanDistance(eye[1], eye[5]);
            const B = faceapi.euclideanDistance(eye[2], eye[4]);
            const C = faceapi.euclideanDistance(eye[0], eye[3]);
            return (A + B) / (2.0 * C);
        }

        function isBlinking(landmarks) {
            const leftEye = landmarks.getLeftEye();
            const rightEye = landmarks.getRightEye();
            const leftEAR = getEyeAspectRatio(leftEye);
            const rightEAR = getEyeAspectRatio(rightEye);
            const EAR = (leftEAR + rightEAR) / 2.0;
            return EAR < 0.25;
        }


        setInterval(async () => {
            const detections = await faceapi.detectAllFaces(video)
                .withFaceLandmarks()
                .withFaceDescriptors();

            if (detections.length > 0) {
                const currentBox = detections[0].detection.box;

                // Detección de movimiento
                if (previousBox) {
                    const deltaX = Math.abs(currentBox.x - previousBox.x);
                    const deltaY = Math.abs(currentBox.y - previousBox.y);
                    const movementThreshold = 0.8;

                    if (deltaX < movementThreshold && deltaY < movementThreshold) {
                        stillFrames++;
                    } else {
                        stillFrames = 0;
                    }
                }
                previousBox = currentBox;

                // Detección de parpadeo
                const blinkDetected = isBlinking(detections[0].landmarks);
                if (!blinkDetected) {
                    noBlinkFrames++;
                } else {
                    noBlinkFrames = 0;
                }

                // 🚨 Validación combinada
                if (stillFrames >= 1 && noBlinkFrames >= 3) {
                    notifyUser("No hay parpadeo ni movimiento facial, posible imagen o pantalla.", true);
                    return;
                }
            }


            const displaySize = { width: video.clientWidth, height: video.clientHeight };
            const resizedDetections = faceapi.resizeResults(detections, displaySize);

            canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
            faceapi.draw.drawDetections(canvas, resizedDetections);
            faceapi.draw.drawFaceLandmarks(canvas, resizedDetections);

            if (labeledFaceDescriptors.length > 0) {
                const faceMatcher = new faceapi.FaceMatcher(labeledFaceDescriptors, 0.5); // Ajustar umbral a 0.5
                const results = resizedDetections.map(d => faceMatcher.findBestMatch(d.descriptor));

                for (let result of results) {
                    const box = resizedDetections[results.indexOf(result)].detection.box;
                    const drawBox = new faceapi.draw.DrawBox(box, { label: result.toString(), boxColor: result.label === 'unknown' ? 'red' : 'green' });
                    drawBox.draw(canvas);

                    if (result.label === 'unknown') {
                        notifyUser('Usuario no encontrado', true);

                        // 🚨 NUEVO: Registrar intento fallido
                        const photoBase64 = capturePhoto(video); // Capturamos la imagen del intento
                        await fetch('/register-failed-attempt', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                cedula: null,
                                nombre: 'Desconocido',
                                empresaId: selectedEmpresaId,
                                motivo: 'Usuario no registrado',
                                fotoIntento: photoBase64
                            })
                        });

                    } else // … dentro de for (let result of results) …
                    if (result.distance < 0.5) {
                        const nombre = result.label;
                        const userId = await getUserIdByName(nombre);
                        if (!userId) return;

                        // Tomamos la foto actual
                        const photoBase64 = capturePhoto(video);

                        // Leemos el tipo de registro seleccionado
                        const tipo = document.getElementById('tipoRegistro').value;
                        if (!tipo) {
                            notifyUser("⚠️ Debe seleccionar si es Entrada o Salida", true);
                            return;
                        }

                        let ok;
                        if (tipo === 'entrada') {
                            ok = await registerEntry(userId, photoBase64);
                        } else { // 'salida'
                            ok = await registerExit(userId);
                        }

                        if (ok) {
                            notifyUser(`✅ ${tipo.charAt(0).toUpperCase()+tipo.slice(1)} registrada exitosamente para ${nombre}`);
                            showCustomAlert(`✅ ${tipo.charAt(0).toUpperCase()+tipo.slice(1)}: ${nombre}`);
                        }
                    }
                }

                }


        }, 1000); // Intervalo ajustado a 1000 ms
    });
}   

// Función para mostrar un alert personalizado
function showCustomAlert(message) {
    const alertBox = document.getElementById('custom-alert');
    alertBox.textContent = message;
    alertBox.style.display = 'block'; // Mostrar el alert

    // Ocultar el alert después de 3 segundos
    setTimeout(() => {
        alertBox.style.display = 'none';
    }, 3000);
}


//Funcion de mensaje
function notifyUser(message, isError = false) {
    const recognitionResult = document.getElementById('recognition-result');
    recognitionResult.style.display = 'block'; // Asegúrate de que se muestre
    recognitionResult.style.color = isError ? 'red' : 'green';
    recognitionResult.style.fontWeight = 'bold'; // Hacer el texto más grueso
    recognitionResult.style.fontSize = '20px'; // Aumentar el tamaño del texto
    recognitionResult.style.backgroundColor = isError ? '#ffcccc' : '#ccffcc'; // Fondo más visible
    recognitionResult.style.padding = '10px'; // Padding para mayor visibilidad
    recognitionResult.style.borderRadius = '5px'; // Bordes redondeados
    recognitionResult.style.border = `2px solid ${isError ? 'red' : 'green'}`; // Borde visible
    recognitionResult.textContent = message;
}




// Función para mostrar un alert personalizado
function showCustomAlert(message) {
    const alertBox = document.getElementById('custom-alert');
    alertBox.textContent = message;
    alertBox.style.display = 'block'; // Mostrar el alert

    // Ocultar el alert después de 3 segundos
    setTimeout(() => {
        alertBox.style.display = 'none';
    }, 4000);
}

// Función para registrar la entrada
async function registerEntry(userId, photoBase64) {
    const localDate = new Date(); // Hora local del cliente
    const ubicacion = "Zona común"; // Puedes cambiar aquí tu ubicación
    const resultado_autenticacion = "Exitosa"; // Siempre será exitosa si llegó aquí

    try {
        const response = await fetch('/register-entry', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                usuarioId: userId,
                empresaId: selectedEmpresaId,
                hora_entrada: localDate.toISOString(), // Mandamos la hora
                ubicacion: ubicacion, // Mandamos ubicación
                resultado_autenticacion: resultado_autenticacion, // Mandamos resultado
                foto_intento: photoBase64 // Mandamos foto
            })
        });

        if (response.ok) {
            notifyUser('Entrada registrada exitosamente.');
            showCustomAlert('Entrada registrada exitosamente.');
            return true;
        } else if (response.status === 409) {
            // No mostramos mensaje para evitar confusión
            console.warn('Intento de doble entrada ignorado.');
        } else {
            notifyUser('Error al registrar la entrada.', true);
        }
    } catch (error) {
        console.error('Error de red al registrar la entrada:', error);
        notifyUser('Error al conectar con el servidor.', true);
    }

    return false;
}




// Función para registrar la salida
async function registerExit(userId) {
    const localDate = new Date(); // Hora local del cliente
    try {
        // Verificar si ya hay una salida registrada para hoy
        const checkResponse = await fetch(`/check-exit?usuarioId=${userId}&empresaId=${selectedEmpresaId}`);
        if (checkResponse.ok) {
            const result = await checkResponse.json();
            if (result.exitExists) {
                notifyUser('Ya se ha registrado una salida para este usuario hoy.');
                return false;
            }
        }

        // Verificar si hay una entrada registrada para poder registrar la salida
        const checkEntryResponse = await fetch(`/check-entry?usuarioId=${userId}&empresaId=${selectedEmpresaId}`);
        if (checkEntryResponse.ok) {
            const entryResult = await checkEntryResponse.json();
            if (!entryResult.entryExists) {
                notifyUser('No hay entrada registrada para este usuario hoy.', true);
                return false; // Detener el proceso para evitar errores
            }
        }

        const response = await fetch('/register-exit', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                usuarioId: userId,
                empresaId: selectedEmpresaId,
                hora_salida: localDate.toISOString() // Enviar la hora local en formato ISO
            })
        });
        if (response.ok) {
            notifyUser('Salida registrada exitosamente.');
            showCustomAlert('Salida registrada exitosamente.'); // Mostrar el alert personalizado
            return true;
        } else if (response.status === 409) {
            notifyUser('No se encontró una entrada válida para hoy.', true);
        } else {
            notifyUser('Error al registrar la salida.', true);
        }
    } catch (error) {
        console.error('Error de red al registrar la salida:', error);
        notifyUser('Error al conectar con el servidor.', true);
    }
    return false;
}




// Función para obtener el ID del usuario por nombre
async function getUserIdByName(name) {
    const response = await fetch(`/get-user-id?name=${name}&empresaId=${selectedEmpresaId}`);
    if (response.ok) {
        const data = await response.json();
        return data.id;
    }
    return null;
}

// Asignar evento al botón "Activar Cámara"
document.getElementById('start-camera').addEventListener('click', async function() {
    console.log("Botón de activar cámara presionado");
    if (selectedEmpresaId) {
        startCamera();
    } else {
        console.error("Seleccione una empresa primero");
    }
});

// Evento para seleccionar una empresa
document.getElementById('selectEmpresa').addEventListener('click', async function() {
    selectedEmpresaId = document.getElementById('empresaSelect').value;
    if (!selectedEmpresaId) {
        console.error("Debe seleccionar una empresa");
        return;
    }

    await loadModels(); // Cargar los modelos
    await loadLabeledImagesAsync(); // Cargar los descriptores de usuarios de forma asíncrona
    console.log("Descriptores cargados:", labeledFaceDescriptors);

    // Mostrar contenido principal y ocultar el formulario de selección
    document.getElementById('main-content').style.display = 'block';
    hideEmpresaForm();
});

document.addEventListener('DOMContentLoaded', function() {
    fetch('/get-empresas')
        .then(response => {
            if (!response.ok) {
                throw new Error('Error leyendo la base de datos de empresas');
            }
            return response.json();
        })
        .then(data => {
            const empresaSelect = document.getElementById('empresaSelect');
            empresaSelect.innerHTML = ''; // Limpiar select para evitar duplicados
            if (data.length > 0) {
                data.forEach(empresa => {
                    const option = document.createElement('option');
                    option.value = empresa.id;
                    option.text = empresa.nombre;
                    empresaSelect.appendChild(option);
                });
            } else {
                console.error("No se encontraron empresas");
            }
        })
        .catch(error => {
            console.error("Error al cargar las empresas:", error);
            document.getElementById('error-message').textContent = "No se pudo cargar la lista de empresas.";
        });

    // Cargar lista de áreas
    fetch('/get-areas')
        .then(res => res.ok ? res.json() : Promise.reject(res.status))
        .then(areas => {
            const sel = document.getElementById('areaSelect');
            areas.forEach(a => {
                const o = document.createElement('option');
                o.value = a.id;
                o.text  = a.nombre;
                sel.appendChild(o);
            });
        })
        .catch(err => console.error('No se pudieron cargar las áreas:', err));

});

function hideEmpresaForm() {
    document.getElementById('empresa-selection').style.display = 'none';
}

// Manejador del evento de envío del formulario
document.getElementById('user-form').addEventListener('submit', async function(event) {
    event.preventDefault(); // Prevenir la recarga de página

    const formData = new FormData(this);
    const submitButton = document.getElementById('submit-button'); // Botón de agregar usuario
    const loadingMessage = document.getElementById('loading-message'); // Mensaje de cargando

    // Mostrar el mensaje de "Agregando usuario..." y deshabilitar el botón
    loadingMessage.style.display = 'block';
    submitButton.disabled = true;

    // Agregar el codigo_empresa al formData
    formData.append('empresaId', selectedEmpresaId);
    
    try {
        const response = await fetch('/upload', {
            method: 'POST',
            body: formData
        });

        if (response.ok) {
            alert('Usuario agregado exitosamente');
            this.reset(); // Limpiar el formulario después de agregar el usuario
        } else if (response.status === 400) {
            alert('El usuario ya está registrado para esta empresa');
        } else {
            alert('Error al agregar el usuario');
        }
    } catch (error) {
        console.error('Error al agregar el usuario:', error);
        alert('Error al conectar con el servidor');
    } finally {
        // Ocultar el mensaje de "Agregando usuario..." y habilitar el botón nuevamente
        loadingMessage.style.display = 'none';
        submitButton.disabled = false;
    }
});