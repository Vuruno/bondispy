#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <curl/curl.h>
#include <sqlite3.h>
#include <json-c/json.h>
#include <time.h>
#include <microhttpd.h>

// SQLite Database
sqlite3 *db;
const char *db_filename = "bus_positions.db";

// HTTP server
#define PORT 8080
struct MHD_Daemon *daemon;

// Utility function to get current datetime
void get_current_datetime(char *buffer) {
    time_t rawtime;
    struct tm *timeinfo;
    time(&rawtime);
    timeinfo = localtime(&rawtime);
    strftime(buffer, 20, "%d-%m-%Y %H:%M:%S", timeinfo);
}

// SQLite function to create table if it doesn't exist
void create_table() {
    const char *sql = "CREATE TABLE IF NOT EXISTS positions (datetime TEXT, linea INTEGER, unidad INTEGER, lat TEXT, lon TEXT, hora TEXT, UNIQUE(linea, unidad, hora));";
    char *err_msg = 0;
    if (sqlite3_exec(db, sql, 0, 0, &err_msg) != SQLITE_OK) {
        fprintf(stderr, "SQL error: %s\n", err_msg);
        sqlite3_free(err_msg);
    }
}

// Function to insert data into the SQLite database
void insert_position(const char *datetime, int linea, int unidad, const char *lat, const char *lon, const char *hora) {
    sqlite3_stmt *stmt;
    const char *sql = "INSERT OR IGNORE INTO positions (datetime, linea, unidad, lat, lon, hora) VALUES (?, ?, ?, ?, ?, ?)";
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, 0) != SQLITE_OK) {
        fprintf(stderr, "Failed to prepare statement: %s\n", sqlite3_errmsg(db));
        return;
    }
    sqlite3_bind_text(stmt, 1, datetime, -1, SQLITE_STATIC);
    sqlite3_bind_int(stmt, 2, linea);
    sqlite3_bind_int(stmt, 3, unidad);
    sqlite3_bind_text(stmt, 4, lat, -1, SQLITE_STATIC);
    sqlite3_bind_text(stmt, 5, lon, -1, SQLITE_STATIC);
    sqlite3_bind_text(stmt, 6, hora, -1, SQLITE_STATIC);

    if (sqlite3_step(stmt) != SQLITE_DONE) {
        fprintf(stderr, "Failed to execute statement: %s\n", sqlite3_errmsg(db));
    }

    sqlite3_finalize(stmt);
}

// Callback function to handle HTTP responses from the API
size_t write_callback(void *ptr, size_t size, size_t nmemb, char *data) {
    size_t total_size = size * nmemb;
    strncat(data, ptr, total_size);
    return total_size;
}

// Function to fetch bus positions for a specific linea
void fetch_bus_positions(int linea_id) {
    CURL *curl;
    CURLcode res;
    char url[256];
    char response[1024] = ""; // Buffer to store the API response
    snprintf(url, sizeof(url), "https://www.jaha.com.py/api/posicionColectivos?linea=%d", linea_id);

    curl_global_init(CURL_GLOBAL_DEFAULT);
    curl = curl_easy_init();
    if (curl) {
        curl_easy_setopt(curl, CURLOPT_URL, url);
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_callback);
        curl_easy_setopt(curl, CURLOPT_WRITEDATA, response);
        res = curl_easy_perform(curl);

        if (res == CURLE_OK) {
            // Parse JSON response
            struct json_object *parsed_json;
            struct json_object *positions;
            parsed_json = json_tokener_parse(response);
            json_object_object_get_ex(parsed_json, "positions", &positions);

            // Get current datetime
            char datetime[20];
            get_current_datetime(datetime);

            // Iterate over positions and store them in SQLite
            size_t n_positions = json_object_array_length(positions);
            for (size_t i = 0; i < n_positions; i++) {
                struct json_object *position = json_object_array_get_idx(positions, i);
                struct json_object *unidad = json_object_object_get(position, "unidad");
                struct json_object *lat = json_object_object_get(position, "lat");
                struct json_object *lon = json_object_object_get(position, "lon");
                struct json_object *hora = json_object_object_get(position, "hora");

                insert_position(datetime,
                                linea_id,
                                json_object_get_int(unidad),
                                json_object_get_string(lat),
                                json_object_get_string(lon),
                                json_object_get_string(hora));
            }
        } else {
            fprintf(stderr, "curl_easy_perform() failed: %s\n", curl_easy_strerror(res));
        }

        curl_easy_cleanup(curl);
    }
    curl_global_cleanup();
}

// HTTP handler for `/positions` endpoint
int handle_positions(void *cls, struct MHD_Connection *connection, const char *url, const char *method,
                     const char *version, const char *upload_data, size_t *upload_data_size, void **con_cls) {
    sqlite3_stmt *stmt;
    const char *sql = "SELECT * FROM positions ORDER BY datetime DESC LIMIT 100";
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, 0) != SQLITE_OK) {
        return MHD_NO;
    }

    struct MHD_Response *response;
    char buffer[2048] = "[";
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        const char *datetime = (const char *)sqlite3_column_text(stmt, 0);
        int linea = sqlite3_column_int(stmt, 1);
        int unidad = sqlite3_column_int(stmt, 2);
        const char *lat = (const char *)sqlite3_column_text(stmt, 3);
        const char *lon = (const char *)sqlite3_column_text(stmt, 4);
        const char *hora = (const char *)sqlite3_column_text(stmt, 5);

        snprintf(buffer + strlen(buffer), sizeof(buffer) - strlen(buffer),
                 "{\"datetime\": \"%s\", \"linea\": %d, \"unidad\": %d, \"lat\": \"%s\", \"lon\": \"%s\", \"hora\": \"%s\"},",
                 datetime, linea, unidad, lat, lon, hora);
    }
    sqlite3_finalize(stmt);
    if (strlen(buffer) > 1) {
        buffer[strlen(buffer) - 1] = ']';  // Remove last comma
        buffer[strlen(buffer)] = '\0';
    } else {
        strcat(buffer, "]");
    }

    response = MHD_create_response_from_buffer(strlen(buffer), (unsigned char *)buffer, MHD_RESPMEM_PERSISTENT);
    int ret = MHD_queue_response(connection, MHD_HTTP_OK, response);
    MHD_destroy_response(response);
    return ret;
}

int main() {
    // Initialize SQLite database
    if (sqlite3_open(db_filename, &db) != SQLITE_OK) {
        fprintf(stderr, "Can't open database: %s\n", sqlite3_errmsg(db));
        return 1;
    }

    create_table(); // Ensure the table is created

    // Start fetching bus positions in a separate thread for each bus line
    for (int i = 1; i <= 10; i++) { // Assuming 10 lines for example
        fetch_bus_positions(i);
        usleep(500000);  // Sleep for 500ms
    }

    // Start HTTP server
    daemon = MHD_start_daemon(MHD_USE_INTERNAL_POLLING_THREAD, PORT, NULL, NULL, &handle_positions, NULL, MHD_OPTION_END);
    if (daemon == NULL) {
        fprintf(stderr, "Error starting HTTP server\n");
        return 1;
    }

    // Run the server indefinitely
    getchar();
    MHD_stop_daemon(daemon);
    sqlite3_close(db);
    return 0;
}